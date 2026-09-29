import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { totalTokenUsage, type StratusEvent, type UsageRecord } from '@stratusagent/core';
import { fleetDbIn } from '@stratusagent/state';
import { createGateway, ShardedSessionStore, SqliteLeaseStore, SqliteUsageLedger } from '../src/index.ts';

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
    assert.equal(row?.inputTokens, total?.inputTokens);
    assert.equal(row?.outputTokens, total?.outputTokens);
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
  let seenForBea: ReturnType<ReturnType<typeof createGateway>['leases']> = [];
  let avaCalls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === 'model-a') {
      avaCalls += 1;
      return avaCalls === 1 ? openAiToolCall('agent_delegate', { agent: 'bea', prompt: 'look into it' }) : openAiText('ava done');
    }
    seenDuringDelegation = gatewayRef?.leases() ?? [];
    // Filtered by agent, folded like the stored half.
    seenForBea = gatewayRef?.leases({ agentId: 'BEA' }) ?? [];
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
    assert.ok(seenForBea.some((lease) => lease.id === sub.id), 'a filtered listing finds the sub-lease whatever the case');
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

test('a sub-lease whose parent is revoked mid-task is listed as revoked, not active', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'provider: openai', 'model: model-a',
    'tools:', '  - agent.delegate', 'delegates:', '  - bea',
    '---', '', 'You are Ava.', '',
  ].join('\n'));
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');
  await writeConfig(home, { leases: { credentials: ['provider:openai'] } });
  let gatewayRef: ReturnType<typeof createGateway> | undefined;
  let parentId = '';
  let seen: ReturnType<ReturnType<typeof createGateway>['leases']> = [];
  let avaCalls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === 'model-a') {
      avaCalls += 1;
      return avaCalls === 1 ? openAiToolCall('agent_delegate', { agent: 'bea', prompt: 'look into it' }) : openAiText('ava done');
    }
    gatewayRef?.revokeLease(parentId, 'cli');
    seen = gatewayRef?.leases() ?? [];
    return openAiText('bea done');
  }) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  gatewayRef = gateway;
  await gateway.start();
  try {
    parentId = gateway.grantLease({
      agentId: 'ava',
      credential: 'provider:openai',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'incident 8',
    }).id;
    // Ava's next call is refused with the lease gone; the listing is the point.
    await gateway.dispatch({ sessionId: 'r-1', agentId: 'ava', userMessage: 'delegate it' }).catch(() => undefined);
    const sub = seen.find((lease) => lease.parentId === parentId);
    assert.ok(sub, 'the sub-lease was listed during the delegated turn');
    assert.equal(sub.revokedAt, undefined, 'its own fields say nothing ended');
    assert.equal(sub.state, 'revoked');
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

test('an agent\'s limit and lease match its id the way identity does, whatever the case it was written in', async () => {
  const home = await newHome();
  await writeSoul(home, 'scout.md', '---\nid: Scout\nname: Scout\nprovider: openai\nmodel: model-a\n---\n\nYou are Scout.\n');
  await writeConfig(home, { budget: { agents: { scout: { daily: 100 } } }, leases: { credentials: ['provider:openai'] } });
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  try {
    gateway.grantLease({ agentId: 'scout', credential: 'provider:openai', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: 'r' });
    await gateway.dispatch({ sessionId: 'c-1', agentId: 'Scout', userMessage: 'one' });
    await assert.rejects(
      gateway.dispatch({ sessionId: 'c-1', agentId: 'Scout', userMessage: 'two' }),
      /Agent Scout has used its daily model budget.*raise budget\.agents\.scout\.daily/,
    );
    assert.equal((await gateway.budget())?.limits[0]?.spent, 120);
  } finally {
    await gateway.stop();
  }
});

test('spend the ledger cannot write is held, budgeted calls are refused until it is, and nothing is lost', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { budget: { daily: 1_000_000 } });
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  // A disk that refuses writes, as SQLite reports one: every insert aborts.
  const { DatabaseSync } = await import('node:sqlite');
  const saboteur = new DatabaseSync(fleetDbIn(path.join(home, '.stratus')));
  try {
    saboteur.exec("CREATE TRIGGER full_disk BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    await gateway.dispatch({ sessionId: 'w-1', agentId: 'ava', userMessage: 'one' });
    await assert.rejects(
      gateway.dispatch({ sessionId: 'w-1', agentId: 'ava', userMessage: 'two' }),
      /Spending could not be recorded \(database or disk is full\)/,
    );
    saboteur.exec('DROP TRIGGER full_disk');
    const recovered = await gateway.dispatch({ sessionId: 'w-1', agentId: 'ava', userMessage: 'three' });
    assert.equal(recovered.status, 'completed');
    // The held call was written on recovery: both answered calls are counted.
    assert.equal(gateway.usage()[0]?.calls, 2);
  } finally {
    saboteur.close();
    await gateway.stop();
  }
});

test('a budget with no limit in it refuses nothing, even while spend cannot be written', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { budget: { weights: { outputTokens: 5 }, agents: { ava: {} } } });
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  const { DatabaseSync } = await import('node:sqlite');
  const saboteur = new DatabaseSync(fleetDbIn(path.join(home, '.stratus')));
  try {
    saboteur.exec("CREATE TRIGGER full_disk BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    await gateway.dispatch({ sessionId: 'n-1', agentId: 'ava', userMessage: 'one' });
    const second = await gateway.dispatch({ sessionId: 'n-1', agentId: 'ava', userMessage: 'two' });
    assert.equal(second.status, 'completed');
    assert.deepEqual((await gateway.budget())?.limits, []);
    // Still held and still reported — only the refusal is gone.
    assert.ok(gateway.unrecordedUsage().calls >= 1);
    saboteur.exec('DROP TRIGGER full_disk');
  } finally {
    saboteur.close();
    await gateway.stop();
  }
});

test('spend saved on a session but never written to the ledger is counted after a restart, and only once', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { budget: { daily: 100 } });
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return openAiText('ok', 90, 20);
  }) as typeof fetch;
  const start = async () => {
    const gateway = createGateway({
      env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
      idleTimeoutMs: 0,
    });
    await gateway.start();
    return gateway;
  };

  const first = await start();
  await first.dispatch({ sessionId: 'c-1', agentId: 'ava', userMessage: 'one' });
  await first.stop();
  // The window a crash leaves: the call's record saved on the session, its
  // ledger row never written.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(fleetDbIn(path.join(home, '.stratus')));
  db.exec('DELETE FROM usage');
  db.close();

  const second = await start();
  try {
    await assert.rejects(
      second.dispatch({ sessionId: 'c-1', agentId: 'ava', userMessage: 'two' }),
      /has used its daily model budget|daily model budget/,
    );
    assert.equal(calls, 1, 'the budget saw the spend before a second call was made');
    // Written once, however many times it is checked.
    await assert.rejects(second.dispatch({ sessionId: 'c-1', agentId: 'ava', userMessage: 'three' }));
    assert.equal(second.usage()[0]?.calls, 1);
  } finally {
    await second.stop();
  }
});

test('a turn a crash left running has its saved spend written to the ledger when the daemon starts', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, '.stratus');
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'crashed-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'go', createdAt: new Date().toISOString() }],
    usage: [{ id: 'call-1', turnId: 'crashed-1:turn:1', provider: 'openai', model: 'model-a', inputTokens: 70 }],
  });
  before.close();

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('unused')) as typeof fetch },
    idleTimeoutMs: 0,
    warn: () => {},
  });
  const events = collect(gateway);
  await gateway.start();
  let atStart: Array<{ agentId: string; calls: number }>;
  try {
    // Written by the time start() returns — before any channel, schedule,
    // or API message can be judged against the home's total — not left to
    // the sweep that fails the turn once the channels are up.
    atStart = gateway.usage().map(({ agentId, calls }) => ({ agentId, calls }));
  } finally {
    // stop() drains the sweep start() began, so the assertions below read what it did.
    await gateway.stop();
  }
  assert.deepEqual(atStart, [{ agentId: 'ava', calls: 1 }]);
  assert.ok(events.some((event) => event.type === 'session.failed' && event.sessionId === 'crashed-1'), 'the sweep ran');

  const ledger = new SqliteUsageLedger(fleetDbIn(stateDir));
  try {
    assert.deepEqual(ledger.totals().map(({ agentId, calls, inputTokens }) => ({ agentId, calls, inputTokens })), [
      { agentId: 'ava', calls: 1, inputTokens: 70 },
    ]);
  } finally {
    ledger.close();
  }
});

test('spend that cannot be written stops only the agents a limit covers', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-a\n---\n\nYou are Bea.\n');
  await writeConfig(home, { budget: { agents: { ava: { daily: 1_000_000 } } } });
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('ok')) as typeof fetch },
    idleTimeoutMs: 0,
    warn: () => {},
  });
  await gateway.start();
  const { DatabaseSync } = await import('node:sqlite');
  const saboteur = new DatabaseSync(fleetDbIn(path.join(home, '.stratus')));
  try {
    saboteur.exec("CREATE TRIGGER full_disk BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    await gateway.dispatch({ sessionId: 'b-1', agentId: 'bea', userMessage: 'one' });
    // Bea has no limit of her own and the home has none: nothing to protect.
    const again = await gateway.dispatch({ sessionId: 'b-1', agentId: 'bea', userMessage: 'two' });
    assert.equal(again.status, 'completed');
    // Ava's limit cannot be judged while spend is unwritten.
    await assert.rejects(
      gateway.dispatch({ sessionId: 'a-1', agentId: 'ava', userMessage: 'one' }),
      /Spending could not be recorded/,
    );
    saboteur.exec('DROP TRIGGER full_disk');
  } finally {
    saboteur.close();
    await gateway.stop();
  }
});

test('spend held in memory only leaves word for the next daemon at once, not only at a stop, and takes it back once written', async () => {
  const home = await newHome();
  const stateDir = path.join(home, '.stratus');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  // Where the hold file goes, a directory: the append fails as well.
  await mkdir(path.join(stateDir, 'usage-held.jsonl'), { recursive: true });
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('ok')) as typeof fetch },
    idleTimeoutMs: 0,
    warn: () => {},
  });
  await gateway.start();
  const { DatabaseSync } = await import('node:sqlite');
  const saboteur = new DatabaseSync(fleetDbIn(stateDir));
  const marker = path.join(stateDir, 'usage-unsettled');
  try {
    saboteur.exec("CREATE TRIGGER full_disk BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    const done = await gateway.dispatch({ sessionId: 'm-1', agentId: 'ava', userMessage: 'one' });
    assert.equal(done.status, 'completed');
    // A crash here runs no stop, and a completed turn is in no sweep of
    // turns left running: the marker has to exist already.
    assert.equal(existsSync(marker), true);

    saboteur.exec('DROP TRIGGER full_disk');
    // The next flush writes what was held in memory; the word is withdrawn.
    gateway.unrecordedUsage();
    assert.equal(existsSync(marker), false);
    assert.equal(gateway.usage()[0]?.calls, 1);
  } finally {
    saboteur.close();
    await gateway.stop();
  }
});

test('a marker for spend no saved session holds stays, and keeps budgeted calls refused, rather than being cleared by an empty settle', async () => {
  const home = await newHome();
  const stateDir = path.join(home, '.stratus');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { budget: { daily: 1_000_000 } });
  // What a crash between announcing a call and saving its session leaves:
  // the marker, and no session with the record on it.
  await writeFile(path.join(stateDir, 'usage-unsettled'), '');
  const warnings: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('ok')) as typeof fetch },
    idleTimeoutMs: 0,
    warn: (line) => warnings.push(line),
  });
  await gateway.start();
  try {
    assert.ok(warnings.some((line) => /none of it is on any saved session/.test(line)), warnings.join('\n'));
    assert.equal(existsSync(path.join(stateDir, 'usage-unsettled')), true);
    await assert.rejects(
      gateway.dispatch({ sessionId: 'e-1', agentId: 'ava', userMessage: 'hello' }),
      /stopped with spend it could not write anywhere/,
    );
  } finally {
    await gateway.stop();
  }
});

test('a settle that committed and died before removing its marker is not mistaken for one that found nothing', async () => {
  const home = await newHome();
  const stateDir = path.join(home, '.stratus');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { budget: { daily: 1_000_000 } });
  const markerPath = path.join(stateDir, 'usage-unsettled');
  await writeFile(markerPath, '');
  // The last start's settle: its rows and its tally committed together,
  // and then the process died with the marker still in place.
  const { lstatSync } = await import('node:fs');
  const stat = lstatSync(markerPath);
  const ledger = new SqliteUsageLedger(fleetDbIn(stateDir));
  assert.equal(
    ledger.settle(
      [{ id: 'call-1', at: new Date().toISOString(), agentId: 'ava', sessionId: 's-1', record: { turnId: 's-1:turn:1', provider: 'openai', inputTokens: 10 } }],
      `${stat.ino}:${stat.mtimeMs}`,
      new Date().toISOString(),
    ),
    1,
  );
  ledger.close();

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('ok')) as typeof fetch },
    idleTimeoutMs: 0,
    warn: () => {},
  });
  await gateway.start();
  try {
    // Replaying inserts nothing now, and the marker is cleared anyway.
    assert.equal(existsSync(markerPath), false);
    const answered = await gateway.dispatch({ sessionId: 'r-1', agentId: 'ava', userMessage: 'hello' });
    assert.equal(answered.status, 'completed');
  } finally {
    await gateway.stop();
  }
});

test('usage totals are one row per agent, however the id was cased when each call was made', () => {
  const ledger = new SqliteUsageLedger(fleetDbIn(path.join(os.tmpdir(), `stratus-ledger-${process.pid}-${Date.now()}`)));
  try {
    const at = new Date().toISOString();
    ledger.record({ id: 'e-1', at, agentId: 'Scout', sessionId: 's', record: { turnId: 's:turn:1', provider: 'openai', model: 'm', inputTokens: 10 } });
    ledger.record({ id: 'e-2', at, agentId: 'scout', sessionId: 's', record: { turnId: 's:turn:2', provider: 'openai', model: 'm', inputTokens: 5 } });
    const rows = ledger.totals({ agentId: 'SCOUT' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.calls, 2);
    assert.equal(rows[0]?.inputTokens, 15);
    // The newest spelling is the one shown.
    assert.equal(rows[0]?.agentId, 'scout');
  } finally {
    ledger.close();
  }
});

test('a budget that has never been readable refuses model calls rather than reading as no limit', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  const configPath = path.join(home, '.stratus', 'config.json');
  await writeFile(configPath, '{ "budget": { "daily": 100 }');
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('ok')) as typeof fetch },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  try {
    await assert.rejects(gateway.budget(), /The spending limit could not be read, so the model was not called/);
    // Once it reads, the limit it names is the one in force — and a later
    // unreadable spell keeps it rather than lifting it.
    await writeFile(configPath, JSON.stringify({ budget: { daily: 100 } }));
    assert.equal((await gateway.budget())?.budget.daily, 100);
    await writeFile(configPath, '{ "budget": ');
    assert.equal((await gateway.budget())?.budget.daily, 100);
  } finally {
    await gateway.stop();
  }
});

test('usage held across a restart is written once the ledger takes it, and refuses budgeted calls until then', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { budget: { daily: 1_000_000 } });
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const start = async () => {
    const gateway = createGateway({
      env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
      idleTimeoutMs: 0,
    });
    await gateway.start();
    return gateway;
  };
  const { DatabaseSync } = await import('node:sqlite');
  const saboteur = new DatabaseSync(fleetDbIn(path.join(home, '.stratus')));
  try {
    const first = await start();
    saboteur.exec("CREATE TRIGGER full_disk BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    await first.dispatch({ sessionId: 'h-1', agentId: 'ava', userMessage: 'one' });
    await first.stop();

    // A new process on the same home: the held call is not forgotten.
    const second = await start();
    try {
      await assert.rejects(
        second.dispatch({ sessionId: 'h-1', agentId: 'ava', userMessage: 'two' }),
        /Spending could not be recorded/,
      );
      saboteur.exec('DROP TRIGGER full_disk');
      await second.dispatch({ sessionId: 'h-1', agentId: 'ava', userMessage: 'three' });
      // The call made before the restart, and the one after: each once.
      assert.equal(second.usage()[0]?.calls, 2);
    } finally {
      await second.stop();
    }
  } finally {
    saboteur.close();
  }
});

test('a primary that spent tokens and then failed is counted before the fallback is allowed to spend more', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\n---\n\nYou are Ava.\n');
  await writeConfig(home, {
    provider: 'metered',
    model: 'primary',
    fallbackProvider: 'metered',
    fallbackModel: 'backup',
    budget: { daily: 50 },
  });
  // A package on disk for the manifest, and its module handed over by the host.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-deploy-pkg-'));
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-metered',
    stratus: { pluginVersion: 1, contributes: { providers: [{ name: 'metered' }] } },
  }));
  let fallbackCalls = 0;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-metered': { enabled: true } },
    pluginHost: {
      resolve: () => pathToFileURL(path.join(root, 'dist', 'index.js')).href,
      import: async () => ({
        createPlugin: () => ({
          name: 'metered',
          setup(context: { providers?: { register(contribution: unknown): void } }) {
            context.providers?.register({
              name: 'metered',
              streams: false,
              create: (selection: { model?: string }) => ({
                name: 'metered',
                async generate(request: { onUsage?: (usage: object) => void }) {
                  if (selection.model === 'primary') {
                    // Billed, then broken: the tokens are spent all the same.
                    request.onUsage?.({ provider: 'metered', model: 'primary', inputTokens: 100 });
                    throw new Error('upstream 500');
                  }
                  fallbackCalls += 1;
                  return { parts: [{ type: 'text', text: 'the fallback answered' }], usage: { provider: 'metered', model: 'backup', inputTokens: 1 } };
                },
              }),
            });
          },
        }),
      }),
    },
  });
  await gateway.start();
  try {
    await assert.rejects(
      gateway.dispatch({ sessionId: 'f-1', agentId: 'ava', userMessage: 'hi' }),
      /This Stratus install has used its daily model budget \(100 of 50/,
    );
    assert.equal(fallbackCalls, 0);
  } finally {
    await gateway.stop();
  }
});

test('a damaged line in held usage refuses budgeted calls rather than being dropped', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeConfig(home, { budget: { daily: 1_000_000 } });
  // What a crash mid-append leaves: a record cut short.
  await writeFile(path.join(home, '.stratus', 'usage-held.jsonl'), '{"id":"e-1","at":"2026-09-29T00:00:00.000Z","agentId":"ava","sess');
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('ok')) as typeof fetch },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  try {
    await assert.rejects(
      gateway.dispatch({ sessionId: 'd-1', agentId: 'ava', userMessage: 'hi' }),
      /line 1 of .*usage-held\.jsonl is damaged/,
    );
    await assert.rejects(gateway.budget(), /Spending could not be recorded/);
    assert.equal(Number.isNaN(gateway.unrecordedUsage().calls), true);
  } finally {
    await gateway.stop();
  }
});

test('usage no disk would take is written out whole as the daemon stops, and the next daemon settles it before a budgeted call', async () => {
  const home = await newHome();
  const stateDir = path.join(home, '.stratus');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  // Where the hold file goes, a directory: the append fails as well.
  await mkdir(path.join(stateDir, 'usage-held.jsonl'), { recursive: true });
  const warnings: string[] = [];
  const logs: string[] = [];
  const start = async () => {
    const gateway = createGateway({
      env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('ok')) as typeof fetch },
      idleTimeoutMs: 0,
      warn: (line) => warnings.push(line),
      log: (line) => logs.push(line),
    });
    await gateway.start();
    return gateway;
  };
  const first = await start();
  const { DatabaseSync } = await import('node:sqlite');
  const saboteur = new DatabaseSync(fleetDbIn(stateDir));
  try {
    saboteur.exec("CREATE TRIGGER full_disk BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    await first.dispatch({ sessionId: 'z-1', agentId: 'ava', userMessage: 'one' });
  } finally {
    await first.stop();
  }
  const last = warnings.find((line) => /stopping with 1 call\(s\) of spend that could not be written anywhere/.test(line));
  assert.ok(last, warnings.join('\n'));
  assert.match(last, /"turnId":"z-1:turn:1"/);
  assert.match(last, /"inputTokens":100/);
  assert.match(last, /Marked .*usage-unsettled/);

  // The disk has room again. Nothing of the call is in the ledger or the
  // hold — only on the session, and in the marker's word that the ledger
  // is short.
  saboteur.exec('DROP TRIGGER full_disk');
  saboteur.close();
  await rm(path.join(stateDir, 'usage-held.jsonl'), { recursive: true });
  await writeConfig(home, { budget: { daily: 100 } });
  const second = await start();
  try {
    assert.ok(logs.some((line) => /settled what the last stratusd could not write/.test(line)), logs.join('\n'));
    assert.equal(second.usage()[0]?.calls, 1);
    // Judged with it counted: 120 of a daily 100.
    await assert.rejects(
      second.dispatch({ sessionId: 'z-2', agentId: 'ava', userMessage: 'another conversation' }),
      /daily model budget/,
    );
  } finally {
    await second.stop();
  }
});
