import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { totalTokenUsage, type StratusEvent, type UsageRecord } from '@stratusagent/core';
import { fleetDbIn } from '@stratusagent/state';
import { createGateway, SqliteLeaseStore, SqliteUsageLedger } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-deploy-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const writeConfig = async (home: string, config: object): Promise<void> => {
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify(config));
};

/** An OpenAI chat completion that reports what it cost. */
const openAiText = (text: string, promptTokens = 100, completionTokens = 20): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    }),
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
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const collect = (gateway: ReturnType<typeof createGateway>): StratusEvent[] => {
  const events: StratusEvent[] = [];
  gateway.bus.subscribe((event) => {
    events.push(event);
  });
  return events;
};

test('a spent daily budget stops the next model call with a sentence, and the fallback does not answer instead', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  // 120 weighted tokens per call; the second call is refused once 150 are spent.
  await writeConfig(home, { budget: { daily: 150 }, fallbackModel: 'model-b' });
  const models: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    models.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return openAiText('hello');
  }) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  const events = collect(gateway);
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 's-1', agentId: 'ava', userMessage: 'one' });
    await gateway.dispatch({ sessionId: 's-1', agentId: 'ava', userMessage: 'two' });
    await assert.rejects(
      gateway.dispatch({ sessionId: 's-1', agentId: 'ava', userMessage: 'three' }),
      /This Stratus install has used its daily model budget \(240 of 150 weighted tokens\).*raise budget\.daily/,
    );
    const failed = events.find((event) => event.type === 'session.failed');
    assert.ok(failed && failed.type === 'session.failed');
    assert.equal(failed.refused, true);
    // The refusal is not a model failing: no fallback call was made.
    assert.deepEqual(models, ['model-a', 'model-a']);
    const budget = await gateway.budget();
    assert.equal(budget?.limits[0]?.reached, true);
  } finally {
    await gateway.stop();
  }
});

test('an agent\'s own limit stops that agent and leaves the others serving', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');
  await writeConfig(home, { budget: { agents: { ava: { monthly: 100 } } } });
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'a-1', agentId: 'ava', userMessage: 'one' });
    await assert.rejects(
      gateway.dispatch({ sessionId: 'a-1', agentId: 'ava', userMessage: 'two' }),
      /Agent ava has used its monthly model budget.*budget\.agents\.ava\.monthly/,
    );
    const answered = await gateway.dispatch({ sessionId: 'b-1', agentId: 'bea', userMessage: 'still here?' });
    assert.equal(answered.status, 'completed');
  } finally {
    await gateway.stop();
  }
});

test('the ledger totals match what the providers reported, call for call', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    return openAiText(`reply ${call}`, 100 * call, 7 * call);
  }) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  let records: UsageRecord[] = [];
  try {
    await gateway.dispatch({ sessionId: 'u-1', agentId: 'ava', userMessage: 'one' });
    const session = await gateway.dispatch({ sessionId: 'u-1', agentId: 'ava', userMessage: 'two' });
    records = session.usage ?? [];
    const [row] = gateway.usage();
    assert.equal(row?.agentId, 'ava');
    assert.equal(row?.calls, 2);
    const total = totalTokenUsage(records);
    assert.equal(row?.inputTokens, total.inputTokens);
    assert.equal(row?.outputTokens, total.outputTokens);
    assert.equal(row?.inputTokens, 300);
    assert.equal(row?.outputTokens, 21);
  } finally {
    await gateway.stop();
  }
  // Durable: another process reads the same numbers from fleet.db.
  const ledger = new SqliteUsageLedger(fleetDbIn(path.join(home, '.stratus')));
  try {
    assert.equal(ledger.spent('1970-01-01T00:00:00.000Z', 'ava'), 321);
    assert.equal(ledger.spent('1970-01-01T00:00:00.000Z', 'ava', { outputTokens: 10, inputTokens: 0 }), 210);
  } finally {
    ledger.close();
  }
});

test('a leased sign-in that runs out mid-conversation stops the next call visibly, naming the lease', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { leases: { credentials: ['provider:openai'] } });
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  const events = collect(gateway);
  await gateway.start();
  try {
    await assert.rejects(
      gateway.dispatch({ sessionId: 'l-1', agentId: 'ava', userMessage: 'before any lease' }),
      /provider:openai may only be used under a lease, and agent ava holds none.*stratus lease grant ava provider:openai/,
    );
    const lease = gateway.grantLease({
      agentId: 'ava',
      credential: 'provider:openai',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxUses: 1,
      reason: 'incident 42',
    });
    const answered = await gateway.dispatch({ sessionId: 'l-1', agentId: 'ava', userMessage: 'now' });
    assert.equal(answered.status, 'completed');
    await assert.rejects(
      gateway.dispatch({ sessionId: 'l-1', agentId: 'ava', userMessage: 'and again' }),
      new RegExp(`lease on provider:openai \\(${lease.id}\\) has used all 1 of its uses`),
    );
    const refusals = events.filter((event) => event.type === 'session.failed' && event.refused === true);
    assert.equal(refusals.length, 2);
    // Every leased use is on the record, allowed and refused alike.
    const leased = events.filter((event) => event.type === 'credential.leased');
    assert.deepEqual(leased.map((event) => event.type === 'credential.leased' && event.outcome), ['refused', 'allowed', 'refused']);
    assert.equal(gateway.leases()[0]?.uses, 1);
  } finally {
    await gateway.stop();
  }
});

test('a revoked lease is the very next use\'s answer, with no restart', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { leases: { credentials: ['provider:openai'] } });
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  try {
    const lease = gateway.grantLease({
      agentId: 'ava',
      credential: 'provider:openai',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'on call',
    });
    await gateway.dispatch({ sessionId: 'r-1', agentId: 'ava', userMessage: 'one' });
    // From another connection, as `stratus lease revoke` does it.
    const cli = new SqliteLeaseStore(fleetDbIn(path.join(home, '.stratus')));
    assert.ok(cli.revoke(lease.id, 'cli'));
    cli.close();
    await assert.rejects(
      gateway.dispatch({ sessionId: 'r-1', agentId: 'ava', userMessage: 'two' }),
      /was revoked by cli at/,
    );
  } finally {
    await gateway.stop();
  }
});

test('a delegated agent borrows the delegator\'s lease as a sub-lease no wider than it, and loses it with the task', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'provider: openai', 'model: model-a',
    'tools:', '  - agent.delegate', 'delegates:', '  - bea',
    '---', '', 'You are Ava.', '',
  ].join('\n'));
  // Bea holds no lease of her own.
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');
  await writeConfig(home, { leases: { credentials: ['provider:openai'] } });

  let gatewayRef: ReturnType<typeof createGateway> | undefined;
  let seenDuringDelegation: ReturnType<ReturnType<typeof createGateway>['leases']> = [];
  let avaCalls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === 'model-a') {
      avaCalls += 1;
      return avaCalls === 1 ? openAiToolCall('agent_delegate', { agent: 'bea', prompt: 'look into it' }) : openAiText('ava done');
    }
    seenDuringDelegation = gatewayRef?.leases() ?? [];
    return openAiText('bea done');
  }) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  gatewayRef = gateway;
  await gateway.start();
  try {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const parent = gateway.grantLease({ agentId: 'ava', credential: 'provider:openai', expiresAt, maxUses: 10, reason: 'incident 7' });
    const session = await gateway.dispatch({ sessionId: 'd-1', agentId: 'ava', userMessage: 'delegate it' });
    const toolMessage = session.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.toolResult?.ok, `delegation failed: ${toolMessage?.toolResult?.error}`);

    const sub = seenDuringDelegation.find((lease) => lease.parentId === parent.id);
    assert.ok(sub, 'Bea ran under a sub-lease of Ava\'s');
    assert.equal(sub.agentId, 'bea');
    assert.equal(sub.credential, 'provider:openai');
    assert.match(sub.sessionId ?? '', /^d-1:delegate:bea:/);
    // Provably narrower: never later, never more uses than the parent had left when lent.
    assert.ok(Date.parse(sub.expiresAt) <= Date.parse(parent.expiresAt));
    assert.ok(sub.maxUses !== undefined && sub.maxUses <= 10 - 1);
    // Bea's use was paid for by Ava's lease: Ava's two calls plus Bea's one.
    const after = gateway.leases().find((lease) => lease.id === parent.id);
    assert.equal(after?.uses, 3);
    // And the sub-lease ended with the delegated turn.
    assert.equal(gateway.leases().some((lease) => lease.parentId === parent.id), false);
  } finally {
    await gateway.stop();
  }
});

test('a sub-lease lasts only as long as the delegated task: the delegate asked directly afterwards is refused', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'provider: openai', 'model: model-a',
    'tools:', '  - agent.delegate', 'delegates:', '  - bea',
    '---', '', 'You are Ava.', '',
  ].join('\n'));
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');
  await writeConfig(home, { leases: { credentials: ['provider:openai'] } });
  let avaCalls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === 'model-a') {
      avaCalls += 1;
      return avaCalls === 1 ? openAiToolCall('agent_delegate', { agent: 'bea', prompt: 'look into it' }) : openAiText('ava done');
    }
    return openAiText('bea done');
  }) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  try {
    gateway.grantLease({
      agentId: 'ava',
      credential: 'provider:openai',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'ava only',
    });
    const session = await gateway.dispatch({ sessionId: 'n-1', agentId: 'ava', userMessage: 'delegate it' });
    const toolMessage = session.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.toolResult?.ok, `delegation failed: ${toolMessage?.toolResult?.error}`);
    await assert.rejects(
      gateway.dispatch({ sessionId: 'bea-direct', agentId: 'bea', userMessage: 'and you, on your own?' }),
      /agent bea holds none/,
    );
  } finally {
    await gateway.stop();
  }
});
