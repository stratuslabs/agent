import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Session } from '@stratusagent/core';
import { removeAgentSignIn, saveAgentSignIn } from '@stratusagent/state';
import { createGateway } from '../src/index.ts';

// Synthetic values only. Each is distinct so a captured call can say which
// account it would have billed, and none is shaped like a real token.
const SHARED_TOKEN = 'synthetic-shared-subscription-token';
const AVA_TOKEN = 'synthetic-ava-subscription-token';
const AVA_ROTATED = 'synthetic-ava-rotated-token';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-signin-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const setUpHome = async (credentials: Record<string, unknown>, config?: Record<string, unknown>): Promise<string> => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: anthropic\n---\n\nYou are Bea.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
  if (config !== undefined) {
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify(config), { mode: 0o600 });
  }
  return home;
};

/** What one Agent SDK `query()` call was handed: the provider invocation boundary. */
interface CapturedCall {
  agent: string;
  token: string | undefined;
  apiKey: string | undefined;
  resume: string | undefined;
}

type QueryOptions = {
  env?: Record<string, string | undefined>;
  resume?: string;
  systemPrompt?: string;
};

/**
 * A stand-in for the Agent SDK's `query()` that records which sign-in each
 * call carried, then answers. Every call mints its own SDK session id, so
 * a later call's `resume` names exactly the call it continued.
 */
const createCapturingQuery = (respond?: (call: CapturedCall) => Promise<void> | void) => {
  const calls: CapturedCall[] = [];
  let minted = 0;
  const queryFn = ((params: { options?: QueryOptions }) => {
    const options = params.options ?? {};
    const agent = /You are (\w+)/.exec(options.systemPrompt ?? '')?.[1] ?? 'unknown';
    const call: CapturedCall = {
      agent,
      token: options.env?.CLAUDE_CODE_OAUTH_TOKEN,
      apiKey: options.env?.ANTHROPIC_API_KEY,
      resume: options.resume,
    };
    calls.push(call);
    minted += 1;
    const sessionId = `sdk-${agent}-${minted}`;
    return (async function* () {
      await respond?.(call);
      yield { type: 'system', subtype: 'init', session_id: sessionId };
      yield { type: 'result', subtype: 'success', is_error: false, result: `${agent} answered`, session_id: sessionId };
    })();
  }) as never;
  return { calls, queryFn };
};

const lastErrorOf = async (dispatched: Promise<Session>): Promise<string> =>
  dispatched.then((session) => session.lastError ?? 'completed', (error: unknown) => String(error));

test('two agents in one daemon, running at once, each reach the provider with their own sign-in', async () => {
  const home = await setUpHome({
    anthropic: { type: 'oauth_token', value: SHARED_TOKEN },
    agentSignIns: { ava: { anthropic: { type: 'oauth_token', value: AVA_TOKEN } } },
  });

  // Both calls are held until both have started, so the two turns are in
  // flight in the same daemon at the same moment. The gate can lose: a
  // turn that never arrives fails the test instead of hanging it.
  let release: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const { calls, queryFn } = createCapturingQuery(async () => {
    started += 1;
    if (started === 2) {
      release();
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      bothStarted,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the second turn never started')), 5_000);
      }),
    ]).finally(() => clearTimeout(timer));
  });

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, queryFn },
    warn: () => {},
  });
  await gateway.start();
  let ava: Session;
  let bea: Session;
  try {
    [ava, bea] = await Promise.all([
      gateway.dispatch({ sessionId: 'ava-1', agentId: 'ava', userMessage: 'hello' }),
      gateway.dispatch({ sessionId: 'bea-1', agentId: 'bea', userMessage: 'hello' }),
    ]);
  } finally {
    await gateway.stop();
  }

  assert.equal(ava.status, 'completed', ava.lastError);
  assert.equal(bea.status, 'completed', bea.lastError);
  assert.equal(started, 2);
  assert.deepEqual(
    calls.map(({ agent, token }) => ({ agent, token })).sort((a, b) => a.agent.localeCompare(b.agent)),
    [
      { agent: 'Ava', token: AVA_TOKEN },
      { agent: 'Bea', token: SHARED_TOKEN },
    ],
  );
  // Subscription billing in both cases: no API key rides along to either.
  assert.ok(calls.every((call) => call.apiKey === undefined));
});

test('rotating, then removing, an agent\'s own sign-in applies on its next turn and never resumes across sign-ins', async () => {
  const home = await setUpHome({
    anthropic: { type: 'oauth_token', value: SHARED_TOKEN },
    agentSignIns: { ava: { anthropic: { type: 'oauth_token', value: AVA_TOKEN } } },
  });
  const { calls, queryFn } = createCapturingQuery();
  const warnings: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, queryFn },
    warn: (line) => warnings.push(line),
  });
  await gateway.start();
  // In a finally, so an assertion failing mid-sequence still stops the
  // daemon: left running, it keeps the test process alive and a regression
  // reads as a hang rather than a failure.
  try {
    const turn = async (message: string): Promise<CapturedCall> => {
      const before = calls.length;
      const session = await gateway.dispatch({ sessionId: 'ava-rotate', agentId: 'ava', userMessage: message });
      assert.equal(session.status, 'completed', session.lastError);
      assert.equal(calls.length, before + 1, 'each turn should make exactly one SDK call');
      return calls.at(-1)!;
    };

    const first = await turn('one');
    const second = await turn('two');
    assert.equal(first.token, AVA_TOKEN);
    // Same sign-in: the SDK session is resumed, as before this change.
    assert.equal(second.resume, 'sdk-Ava-1');

    // Rotated while the daemon runs, through the same writer the CLI uses.
    await saveAgentSignIn({ homeDir: home }, 'ava', 'anthropic', { type: 'oauth_token', value: AVA_ROTATED });
    const rotated = await turn('three');
    assert.equal(rotated.token, AVA_ROTATED);
    assert.equal(rotated.resume, undefined, 'a session made under the old token must not be resumed under the new one');
    const afterRotation = await turn('four');
    assert.equal(afterRotation.resume, 'sdk-Ava-3', 'the session made under the new token resumes normally');

    // Removed: back to the shared sign-in, again without resuming.
    assert.equal(await removeAgentSignIn({ homeDir: home }, 'ava', 'anthropic'), true);
    const shared = await turn('five');
    assert.equal(shared.token, SHARED_TOKEN);
    assert.equal(shared.resume, undefined);
  } finally {
    await gateway.stop();
  }

  // Nothing the daemon said, and nothing it stored, carries a token.
  const stored = await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8');
  assert.ok(!stored.includes(AVA_TOKEN), 'the rotated-away token should be gone from the store');
  for (const secret of [SHARED_TOKEN, AVA_TOKEN, AVA_ROTATED]) {
    assert.ok(!warnings.some((line) => line.includes(secret)), `a warning carried ${secret}`);
  }
});

test('the sessions a daemon persists carry no sign-in, only a fingerprint of which one made them', async () => {
  const home = await setUpHome({
    anthropic: { type: 'oauth_token', value: SHARED_TOKEN },
    agentSignIns: { ava: { anthropic: { type: 'oauth_token', value: AVA_TOKEN } } },
  });
  const { queryFn } = createCapturingQuery();
  const gateway = createGateway({ env: { homeDir: home, cwd: home, processEnv: {}, queryFn }, warn: () => {} });
  await gateway.start();
  let session: Session;
  try {
    session = await gateway.dispatch({ sessionId: 'ava-leak', agentId: 'ava', userMessage: 'hello' });
  } finally {
    await gateway.stop();
  }

  const serialized = JSON.stringify(session);
  assert.ok(!serialized.includes(AVA_TOKEN));
  assert.ok(!serialized.includes(SHARED_TOKEN));
  assert.match(String(session.metadata?.claudeCodeAuth), /^token:[0-9a-f]{16}$/);
});

test('a rejected sign-in of the agent\'s own fails as itself, and never falls back onto a shared account', async () => {
  const home = await setUpHome(
    {
      anthropic: { type: 'oauth_token', value: SHARED_TOKEN },
      openai: { type: 'api_key', value: 'synthetic-openai-key' },
      agentSignIns: { ava: { anthropic: { type: 'oauth_token', value: AVA_TOKEN } } },
    },
    // A cross-provider fallback is configured on purpose: for an agent on
    // the shared sign-in it would rescue the turn, and for Ava it must not.
    { provider: 'anthropic', fallbackProvider: 'openai', fallbackModel: 'model-f' },
  );
  const { calls, queryFn } = createCapturingQuery((call) => {
    if (call.token === AVA_TOKEN) {
      throw new Error('Claude Code returned an error result: Invalid API key · Please run /login');
    }
  });
  let fetched = 0;
  const fetchImpl = (async () => {
    fetched += 1;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fallback' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, queryFn, fetch: fetchImpl },
    warn: () => {},
  });
  await gateway.start();
  let outcome: string;
  let beaOutcome: string;
  try {
    outcome = await lastErrorOf(gateway.dispatch({ sessionId: 'ava-bad', agentId: 'ava', userMessage: 'hello' }));
    // The control: the same fallback does serve an agent on the shared sign-in.
    beaOutcome = await lastErrorOf(gateway.dispatch({ sessionId: 'bea-ok', agentId: 'bea', userMessage: 'hello' }));
  } finally {
    await gateway.stop();
  }

  assert.match(outcome, /Claude refused ava's own sign-in/);
  assert.match(outcome, /stratus signin set anthropic --agent ava/);
  assert.ok(!outcome.includes(AVA_TOKEN));
  assert.equal(fetched, 0, 'the openai fallback should not have been called for ava');
  assert.deepEqual(calls.filter((call) => call.agent === 'Ava').map((call) => call.token), [AVA_TOKEN]);
  assert.equal(beaOutcome, 'completed');
});

test('an agent with no sign-in of its own resolves and resumes exactly as before', async () => {
  const home = await setUpHome({ anthropic: { type: 'oauth_token', value: SHARED_TOKEN } });
  const { calls, queryFn } = createCapturingQuery();
  const gateway = createGateway({ env: { homeDir: home, cwd: home, processEnv: {}, queryFn }, warn: () => {} });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'bea-plain', agentId: 'bea', userMessage: 'one' });
    await gateway.dispatch({ sessionId: 'bea-plain', agentId: 'bea', userMessage: 'two' });
  } finally {
    await gateway.stop();
  }

  assert.deepEqual(calls.map(({ token, resume }) => ({ token, resume })), [
    { token: SHARED_TOKEN, resume: undefined },
    { token: SHARED_TOKEN, resume: 'sdk-Bea-1' },
  ]);
});
