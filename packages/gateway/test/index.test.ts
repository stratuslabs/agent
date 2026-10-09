import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PENDING_APPROVAL_METADATA_KEY,
  RunAbortedError,
  turnReplyFor,
  type ApprovalAnswer,
  type ApprovalOutcome,
  type StratusEvent,
} from '@stratusagent/core';
import {
  ABANDONED_TURN_ERROR,
  ORPHANED_DELEGATION_ERROR,
  RESERVED_SESSION_METADATA_KEYS,
  createGateway,
  ShardedSessionStore,
  SqliteScheduleStore,
  SqliteSessionStore,
  type ApprovalTransport,
  type GatewayChannelAdapter,
} from '../src/index.ts';
import {
  GATEWAY_ONLY_TOOL_NAMES,
  FORGET_TOOL_NAME,
  PIN_TOOL_NAME,
  RECALL_TOOL_NAME,
  MEMORY_TOOL_NAME,
} from '@stratusagent/agents';
import { SKILL_READ_TOOL_NAME } from '@stratusagent/core';
import { createHomeMemoryStore, fleetDbIn, legacyMemoryFilePath } from '@stratusagent/state';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

// A minimal Anthropic SSE stream: the gateway's streaming path (anthropic +
// apiKey) drives the SDK's stream parser, which wants real event framing.
/**
 * One SSE frame's payload. Typed as "a `type` plus whatever else that event
 * carries", because the helper only reads `type` and serializes the rest —
 * describing it as `{ type: string }` made every realistic event literal an
 * excess-property error.
 */
type SseEvent = { type: string } & Record<string, unknown>;

const anthropicSse = (events: SseEvent[]): Response =>
  new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const anthropicMessageStart = {
  type: 'message_start',
  message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'model-x', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  },
};

const anthropicSseText = (text: string): Response =>
  anthropicSse([
    anthropicMessageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);

const anthropicSseToolCall = (wireName: string, args: object): Response =>
  anthropicSse([
    anthropicMessageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: wireName, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);

const openAiToolCall = (name: string, args: object): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('sessions survive a gateway restart and resume with full history', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  const first = createGateway({ env, idleTimeoutMs: 0 });
  await first.start();
  const opening = await first.dispatch({ sessionId: 'thread-1', userMessage: 'say hello' });
  assert.equal(opening.status, 'completed');
  await first.stop();

  // A brand-new gateway process over the same home: the same session id
  // must continue the conversation, not start a new one.
  const second = createGateway({ env, idleTimeoutMs: 0 });
  await second.start();
  const resumed = await second.dispatch({ sessionId: 'thread-1', userMessage: 'still there?' });
  await second.stop();

  const userMessages = resumed.messages.filter((message) => message.role === 'user').map((m) => m.content);
  assert.deepEqual(userMessages, ['say hello', 'still there?']);
  assert.equal(resumed.status, 'completed');
});

test('a session\'s routing carries its latest reply, for a channel finishing a turn it did not start', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    assert.equal(await gateway.sessionRouting('nothing-yet'), undefined);
    const session = await gateway.dispatch({ sessionId: 'thread-r', userMessage: 'say hello' });
    const lastReply = [...session.messages].reverse().find((message) => message.role === 'assistant')?.content;
    assert.ok(lastReply, 'the turn produced a reply');
    const routing = await gateway.sessionRouting('thread-r');
    assert.equal(routing?.agentId, session.agent.id);
    assert.equal(routing?.reply, lastReply);

    // A later turn that produced no text has no reply: the earlier answer
    // must not be posted again as though it answered the new message.
    const stored = await gateway.store.get('thread-r');
    assert.ok(stored);
    stored.messages.push(
      { id: 'thread-r:user:2', role: 'user', content: 'and again', createdAt: new Date().toISOString() },
      { id: 'thread-r:assistant:2', role: 'assistant', content: '  \n', createdAt: new Date().toISOString() },
    );
    await gateway.store.save(stored);
    assert.equal((await gateway.sessionRouting('thread-r'))?.reply, undefined);
  } finally {
    await gateway.stop();
  }
});

test('a session\'s routing reports when its agent last spoke, not when the row last changed', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    const session = await gateway.dispatch({ sessionId: 'thread-s', userMessage: 'say hello' });
    const spoke = [...session.messages].reverse().find((message) => message.role === 'assistant')?.createdAt;
    assert.ok(spoke, 'the turn produced a reply');
    assert.equal((await gateway.sessionRouting('thread-s'))?.lastSpokeAt, spoke);

    // A save that is not the agent speaking — a tool result, an approval
    // checkpoint, a recovery resuming — moves the row's own timestamp and
    // must not move this. A channel ordering two agents by who spoke last
    // would otherwise hand the thread to whichever is mid-turn.
    const stored = await gateway.store.get('thread-s');
    assert.ok(stored);
    stored.messages.push({ id: 'thread-s:user:2', role: 'user', content: 'and again', createdAt: new Date().toISOString() });
    await gateway.store.save(stored);
    const after = await gateway.sessionRouting('thread-s');
    assert.equal(after?.lastSpokeAt, spoke);
    // That the row did change is proved by what is in it, not by its
    // timestamp differing from the reply's: both are `Date.now()` at
    // millisecond resolution, and a dispatch that finishes inside one tick
    // makes them equal — a race the assertion loses on a loaded runner
    // rather than a regression it catches.
    assert.equal((await gateway.store.get('thread-s'))?.messages.length, stored.messages.length);
  } finally {
    await gateway.stop();
  }
});

test('observe puts a message into a session with no turn, on the session\'s chain, and refuses what dispatch refuses', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  const events: StratusEvent[] = [];
  gateway.bus.subscribe((event) => {
    events.push(event);
  });
  try {
    const first = await gateway.dispatch({ sessionId: 'thread-o', userMessage: 'Dylan: Ava, hello' });
    const spoke = (await gateway.sessionRouting('thread-o'))?.lastSpokeAt;
    assert.ok(spoke);
    const updatedBefore = events.filter((event) => event.type === 'session.updated').length;

    const observed = await gateway.observe({ sessionId: 'thread-o', message: 'Dylan: Bea, what do you think?' });
    assert.ok(observed, 'the agent is in this conversation');

    // Appended and durable, and no turn ran: same status the last turn
    // left, its own event and not a `session.updated`, and the agent has
    // not spoken since — an adapter ordering agents by who spoke last
    // must not see an overhear as speaking.
    assert.equal(observed.messages.length, first.messages.length + 1);
    assert.equal(observed.status, first.status);
    const stored = await gateway.store.get('thread-o');
    assert.equal(stored?.messages.at(-1)?.overheard, true);
    assert.equal(stored?.messages.at(-1)?.content, 'Dylan: Bea, what do you think?');
    assert.equal(events.filter((event) => event.type === 'session.updated').length, updatedBefore);
    assert.deepEqual(
      events.filter((event) => event.type === 'session.observed'),
      [{ type: 'session.observed', sessionId: 'thread-o', agentId: first.agent.id }],
    );
    assert.equal((await gateway.sessionRouting('thread-o'))?.lastSpokeAt, spoke);
    // And it has heard one message since it last answered: the other half
    // of an attention window, counted from the session so a restart
    // forgets nothing.
    assert.equal((await gateway.sessionRouting('thread-o'))?.lastAnsweredAt, spoke);
    assert.equal((await gateway.sessionRouting('thread-o'))?.heardSinceAnswered, 1);

    // The next turn carries it, ahead of the message that started the turn.
    const next = await gateway.dispatch({ sessionId: 'thread-o', userMessage: 'Dylan: Ava, and you?' });
    const users = next.messages.filter((message) => message.role === 'user').map((message) => [message.content, message.overheard === true]);
    assert.deepEqual(users, [
      ['Dylan: Ava, hello', false],
      ['Dylan: Bea, what do you think?', true],
      ['Dylan: Ava, and you?', false],
    ]);
    assert.equal((await gateway.sessionRouting('thread-o'))?.heardSinceAnswered, 0);

    // A turn dispatched unaddressed carries the same mark through to the
    // runner: the message is stored overheard, on a new session and an
    // existing one alike, and the turn is nobody's to answer.
    const answered = (await gateway.sessionRouting('thread-o'))?.lastAnsweredAt;
    assert.equal((await gateway.sessionRouting('thread-o'))?.unaddressed, undefined);
    const unasked = await gateway.dispatch({ sessionId: 'thread-o', userMessage: 'Bea: on it', addressed: false });
    const unaskedMessage = unasked.messages.findLast((message) => message.role === 'user');
    assert.equal(unaskedMessage?.overheard, true);
    assert.equal(unaskedMessage?.content, 'Bea: on it');
    // The reply it chose to give on a turn nobody asked for is speaking,
    // for the thread rule, and not an anchor: attention runs from the
    // last message that addressed it, and this one counts against it.
    const afterUnasked = await gateway.sessionRouting('thread-o');
    assert.notEqual(afterUnasked?.lastSpokeAt, answered);
    assert.equal(afterUnasked?.lastAnsweredAt, answered);
    assert.equal(afterUnasked?.heardSinceAnswered, 1);
    // And the routing says whose turn it is on: nobody's, so a channel
    // that finds it failed after a restart knows to keep quiet for it.
    assert.equal(afterUnasked?.unaddressed, true);
    const opened = await gateway.dispatch({ sessionId: 'thread-unasked', userMessage: 'Dylan: Bea?', addressed: false });
    assert.equal(opened.messages[0]?.overheard, true);

    // A file is speaking: a turn whose tool result carried one put
    // something in the thread, and the durable answer says so — as the
    // adapter's in-process record already does — so a restart does not
    // hand the thread back to whoever spoke in words last.
    const filed = await gateway.store.get('thread-o');
    assert.ok(filed);
    const at = '2026-09-12T12:00:00.000Z';
    filed.messages.push(
      { id: 'thread-o:user:f1', role: 'user', content: 'Sam: chart?', createdAt: at, overheard: true },
      { id: 'thread-o:assistant:f2', role: 'assistant', content: '', createdAt: at, toolCalls: [{ id: 'c1', toolName: 'chart.render', input: {} }] },
      { id: 'thread-o:tool:c1', role: 'tool', name: 'chart.render', content: '{}', createdAt: at, toolResult: { callId: 'c1', toolName: 'chart.render', ok: true, output: { file: '/tmp/chart.png' } } },
    );
    await gateway.store.save(filed);
    const withFile = await gateway.sessionRouting('thread-o');
    assert.equal(withFile?.lastSpokeAt, at);
    // Though a turn nobody asked for, so not an answer: the anchor stays.
    assert.equal(withFile?.lastAnsweredAt, answered);
    assert.equal(withFile?.heardSinceAnswered, 2);

    // An agent hears only conversations it is already in: nothing is
    // created on its behalf, and "not in that one" is an answer rather
    // than a refusal — a channel asks this for every thread its app can
    // see.
    assert.equal(await gateway.observe({ sessionId: 'never-seen', message: 'anyone?' }), undefined);
    assert.equal(await gateway.store.get('never-seen'), undefined);

    // Read on the chain, behind a dispatch queued ahead of it: the
    // invitation that creates the session has landed by the time the
    // observe looks, so a message said moments after a first mention is
    // heard rather than dropped. Neither call is awaited before the other
    // is placed — that is the shape a channel produces.
    const invitation = gateway.dispatch({ sessionId: 'thread-fresh', userMessage: 'Dylan: Ava, hello' });
    const heard = gateway.observe({ sessionId: 'thread-fresh', message: 'Dylan: Bea, and you?' });
    await invitation;
    assert.equal((await heard)?.messages.at(-1)?.overheard, true);
    // Sessions never cross agent identities, by the same door dispatch uses.
    await assert.rejects(
      () => gateway.observe({ sessionId: 'thread-o', agentId: 'somebody-else', message: 'hm' }),
      /belongs to agent .* not somebody-else/,
    );
    // And the scheduler's namespace is as closed to an overhear as to a turn.
    await assert.rejects(
      () => gateway.observe({ sessionId: 'schedule:x:y', message: 'psst' }),
      /reserved for scheduled firings/,
    );
  } finally {
    await gateway.stop();
  }
});

test('sqlite sessions round-trip metadata (anthropic raw-turn cache included)', async () => {
  const home = await newHome();
  const store = new ShardedSessionStore({ stateDir: path.join(home, 'state') });
  await store.create({
    id: 's1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [],
    metadata: { anthropicRawTurns: { 'call-1': [{ type: 'thinking', thinking: 'hmm' }] } },
  });
  const loaded = await store.get('s1');
  assert.deepEqual(loaded?.metadata, { anthropicRawTurns: { 'call-1': [{ type: 'thinking', thinking: 'hmm' }] } });
  store.close();
});

test('agents pinned to different models run through their own provider config', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');

  const requestedModels: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(body.model);
    return openAiText(`reply from ${body.model}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const fromAva = await gateway.dispatch({ sessionId: 'a-1', agentId: 'ava', userMessage: 'hi' });
  const fromBea = await gateway.dispatch({ sessionId: 'b-1', agentId: 'bea', userMessage: 'hi' });
  await gateway.stop();

  assert.deepEqual(requestedModels, ['model-a', 'model-b']);
  assert.match(fromAva.messages.at(-1)?.content ?? '', /model-a/);
  assert.match(fromBea.messages.at(-1)?.content ?? '', /model-b/);
});

test('each turn tells the agent the room it is in now, a resumed conversation included', async () => {
  // The room rides on the turn, not the session's first metadata: a thread
  // that started before this existed, or a channel that has grown since,
  // is described as it is on this turn.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const prompts: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    prompts.push(body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'));
    return openAiText('ok');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    const turn = (members: number) => gateway.dispatch({
      sessionId: 'slack:ava:T1:C1:100.1',
      agentId: 'ava',
      userMessage: 'hi',
      metadata: { channel: 'slack', conversation: { kind: 'public', members } },
    });
    await turn(12);
    await turn(13);
    assert.match(prompts[0] ?? '', /a public Slack channel with 12 members/);
    assert.match(prompts[1] ?? '', /a public Slack channel with 13 members/);
    // Kept on the session too, for a parked turn recovered after a restart
    // and a turn that brings no room of its own.
    const stored = await gateway.store.get('slack:ava:T1:C1:100.1');
    assert.deepEqual(stored?.metadata?.conversation, { kind: 'public', members: 13 });

    // A channel turn that could not tell the room clears the stored one:
    // the generic line, never the last room passed off as current.
    await gateway.dispatch({ sessionId: 'slack:ava:T1:C1:100.1', agentId: 'ava', userMessage: 'hi', metadata: { channel: 'slack' } });
    assert.match(prompts[2] ?? '', /this conversation is happening in Slack\./);
    assert.doesNotMatch(prompts[2] ?? '', /13 members/);
    assert.equal((await gateway.store.get('slack:ava:T1:C1:100.1'))?.metadata?.conversation, undefined);
  } finally {
    await gateway.stop();
  }
});

test('delegation runs the target on the target\'s own provider config', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---',
    'name: Ava',
    'provider: openai',
    'model: model-a',
    'tools:',
    '  - agent.delegate',
    'delegates:',
    '  - bea',
    '---',
    '',
    'You are Ava, an orchestrator.',
    '',
  ].join('\n'));
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');

  let avaCalls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === 'model-a') {
      avaCalls += 1;
      return avaCalls === 1
        ? openAiToolCall('agent_delegate', { agent: 'Bea', prompt: 'take this over' })
        : openAiText('ava done');
    }
    return openAiText(`bea here on ${body.model}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'orchestrate-1', agentId: 'ava', userMessage: 'delegate please' });
  await gateway.stop();

  const toolMessage = session.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage?.toolResult?.ok, `delegation failed: ${toolMessage?.toolResult?.error}`);
  const output = toolMessage.toolResult.output as { agent: string; reply: string };
  assert.equal(output.agent, 'Bea');
  // The delegated turn ran on Bea's model — never on the delegator's.
  assert.match(output.reply, /model-b/);
});

test('the watchdog aborts a stalled streaming turn and fails the session cleanly', async () => {
  const home = await newHome();
  // The idle watchdog applies to delta-streaming providers (Anthropic API
  // path); a request that never resolves until its signal fires simulates
  // a stall, and the abort must cancel the underlying request.
  await writeSoul(home, 'slow.md', '---\nname: Slow\nprovider: anthropic\nmodel: model-slow\n---\n\nYou stall.\n');

  const fetchImpl = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { ANTHROPIC_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const warnings: string[] = [];
  const gateway = createGateway({ env, idleTimeoutMs: 300, warn: (line) => warnings.push(line) });
  const failed = nextEvent(gateway.bus, 'session.failed');
  await gateway.start();

  try {
    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'stalled-1', agentId: 'slow', userMessage: 'hang' }),
      (error: Error) => error instanceof RunAbortedError && /no activity/.test(error.message),
    );

    // The log line says what was last heard and whether the provider had
    // reported anything at all — the difference between a stream that went
    // quiet and progress that never reached the bus.
    const line = warnings.find((warning) => warning.startsWith('watchdog:'));
    assert.match(line ?? '', /no activity on session stalled-1 for 300ms; aborting the turn \(last heard: \S+; 0 provider deltas this turn\)$/);

    // The reason reaches the record and the event, not only the dispatcher:
    // an operator reading the session, or a surface on the bus, can tell a
    // watchdog abort from a person cancelling.
    const stored = await gateway.store.get('stalled-1');
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.lastError, 'Run aborted: no activity for 300ms');
    assert.equal((await failed).error, 'Run aborted: no activity for 300ms');
  } finally {
    // A failed assertion must not leave the gateway holding the process open.
    await gateway.stop();
  }
});

test('the idle watchdog stays off for non-streaming providers', async () => {
  const home = await newHome();
  await writeSoul(home, 'steady.md', '---\nname: Steady\nprovider: openai\nmodel: model-a\n---\n\nYou take your time.\n');

  // Slower than the idle timeout, but healthy: a non-streaming provider
  // emits no deltas, so the watchdog must not treat silence as a stall.
  const fetchImpl = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return openAiText('worth the wait');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 100, warn: () => {} });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'steady-1', agentId: 'steady', userMessage: 'take your time' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /worth the wait/);
});

test('a rotated credential reaches the provider on the next dispatch', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  const authHeaders: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    authHeaders.push(String((init?.headers as Record<string, string>)?.authorization ?? ''));
    return openAiText('ok');
  }) as typeof fetch;

  const processEnv: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-before' };
  const env = { homeDir: home, cwd: home, processEnv, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  await gateway.dispatch({ sessionId: 'rotate-1', agentId: 'ava', userMessage: 'one' });
  processEnv.OPENAI_API_KEY = 'sk-after';
  await gateway.dispatch({ sessionId: 'rotate-2', agentId: 'ava', userMessage: 'two' });
  await gateway.stop();

  assert.deepEqual(authHeaders, ['Bearer sk-before', 'Bearer sk-after']);
});

test('an agent that cannot currently answer still hears, and has it once it can', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const userContents: string[][] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    userContents.push(body.messages.filter((message) => message.role === 'user').map((message) => message.content));
    return openAiText('ok');
  }) as typeof fetch;
  const processEnv: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-test' };
  const gateway = createGateway({ env: { homeDir: home, cwd: home, processEnv, fetch: fetchImpl }, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'quiet-1', agentId: 'ava', userMessage: 'Dylan: Ava, hello' });

    // The credential goes away — a sign-in that lapsed, a restart without
    // the env. A turn cannot be run, and says so.
    delete processEnv.OPENAI_API_KEY;
    await assert.rejects(() => gateway.dispatch({ sessionId: 'quiet-1', agentId: 'ava', userMessage: 'Dylan: Ava?' }));

    // Hearing runs no turn and needs no provider: the thread carries on
    // without the agent, and what was said is not lost to the outage.
    const heard = await gateway.observe({ sessionId: 'quiet-1', agentId: 'ava', message: 'Dylan: Bea, cover for her?' });
    assert.equal(heard?.messages.at(-1)?.overheard, true);

    // Repaired, the next turn reads what was heard while it was down.
    processEnv.OPENAI_API_KEY = 'sk-test';
    await gateway.dispatch({ sessionId: 'quiet-1', agentId: 'ava', userMessage: 'Dylan: Ava, back?' });
    assert.deepEqual(userContents.at(-1), [
      'Dylan: Ava, hello',
      '(overheard, not addressed to you)\n> Dylan: Bea, cover for her?',
      'Dylan: Ava, back?',
    ]);
  } finally {
    await gateway.stop();
  }
});

test('a session never crosses agent identities', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };

  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  await gateway.dispatch({ sessionId: 'shared-1', agentId: 'ava', userMessage: 'hi' });
  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'shared-1', agentId: 'stratus', userMessage: 'hijack' }),
    /never cross agent identities/,
  );
  await gateway.stop();
});

test('a soul edit reaches an existing session on its next turn', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are cheerful.\n');

  const systemPrompts: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    systemPrompts.push(body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n'));
    return openAiText('ok');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  await gateway.dispatch({ sessionId: 'edit-1', agentId: 'ava', userMessage: 'hi' });
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are extremely grumpy.\n');
  await gateway.dispatch({ sessionId: 'edit-1', agentId: 'ava', userMessage: 'hi again' });
  await gateway.stop();

  assert.match(systemPrompts[0] ?? '', /cheerful/);
  assert.match(systemPrompts[1] ?? '', /extremely grumpy/);
});

test('messages to one session are single-flight; separate sessions run concurrently', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  let inFlight = 0;
  let sawOverlapSameSession = false;
  let sawConcurrency = false;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const last = body.messages.at(-1)?.content ?? '';
    inFlight += 1;
    if (inFlight > 1) {
      if (last.startsWith('same')) {
        sawOverlapSameSession = true;
      }
      sawConcurrency = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    inFlight -= 1;
    return openAiText(`echo ${last}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const [one, two] = await Promise.all([
    gateway.dispatch({ sessionId: 'sf-1', agentId: 'ava', userMessage: 'same first' }),
    gateway.dispatch({ sessionId: 'sf-1', agentId: 'ava', userMessage: 'same second' }),
  ]);
  await Promise.all([
    gateway.dispatch({ sessionId: 'p-1', agentId: 'ava', userMessage: 'parallel one' }),
    gateway.dispatch({ sessionId: 'p-2', agentId: 'ava', userMessage: 'parallel two' }),
  ]);
  await gateway.stop();

  assert.equal(sawOverlapSameSession, false, 'same-session turns must not interleave');
  assert.equal(sawConcurrency, true, 'separate sessions should run concurrently');
  // The queued second message resumed the same session after the first.
  assert.equal(two.messages.filter((m) => m.role === 'user').length, 2);
  assert.equal(one.messages.filter((m) => m.role === 'user').length, 1);
});

test('a stopping gateway refuses new work but drains in-flight turns', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const turn = gateway.dispatch({ sessionId: 'drain-1', userMessage: 'say hello' });
  const stopped = gateway.stop();
  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'drain-2', userMessage: 'too late' }),
    /stopping/,
  );
  const session = await turn;
  assert.equal(session.status, 'completed');
  await stopped;
});

test('the session database and its directory are owner-only', async () => {
  const { stat } = await import('node:fs/promises');
  const home = await newHome();
  const dbPath = path.join(home, 'state', 'sessions.db');
  const store = new SqliteSessionStore(dbPath);
  store.close();

  assert.equal(((await stat(path.dirname(dbPath))).mode & 0o777), 0o700);
  assert.equal(((await stat(dbPath)).mode & 0o777), 0o600);
});

test('a pre-existing loose session directory is tightened to owner-only', async () => {
  const { stat } = await import('node:fs/promises');
  const home = await newHome();
  // The upgrade path: ~/.stratus already exists with the default 0755 from
  // an earlier install. mkdir's mode only applies to directories it
  // creates, so the constructor must chmod explicitly — but only for a
  // directory declared as dedicated Stratus state.
  const dir = path.join(home, 'state');
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const dbPath = path.join(dir, 'sessions.db');
  const store = new SqliteSessionStore(dbPath, { stateHome: dir, ownedHome: true });
  store.close();

  assert.equal(((await stat(dir)).mode & 0o777), 0o700);
});

test('a caller-supplied parent directory is never chmodded', async () => {
  const { stat } = await import('node:fs/promises');
  const home = await newHome();
  // An embedder pointing sessionDbPath at a shared directory (think /tmp
  // or a project root): the store must not change that directory's
  // permissions from under other processes. The database file itself is
  // still tightened — it is always ours.
  const dir = path.join(home, 'shared');
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const dbPath = path.join(dir, 'sessions.db');
  const store = new SqliteSessionStore(dbPath);
  store.close();

  assert.equal(((await stat(dir)).mode & 0o777), 0o755);
  assert.equal(((await stat(dbPath)).mode & 0o777), 0o600);
});

test('a queued dispatch whose signal aborted while waiting never mutates the session', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    await new Promise((resolve) => setTimeout(resolve, 60));
    return openAiText(`echo ${body.messages.at(-1)?.content ?? ''}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const controller = new AbortController();
  const first = gateway.dispatch({ sessionId: 'q-1', agentId: 'ava', userMessage: 'first' });
  const second = gateway.dispatch({ sessionId: 'q-1', agentId: 'ava', userMessage: 'second', signal: controller.signal });
  // Aborted with a reason, while `second` waits behind `first`: the refusal
  // happens before the runner ever sees the signal, and it must still be
  // the caller's own error that comes back, not a bare default.
  const reason = new RunAbortedError('Run aborted: the caller gave up');
  controller.abort(reason);

  let stored;
  try {
    const settled = await first;
    await assert.rejects(() => second, (error: unknown) => error === reason);
    assert.equal(settled.status, 'completed');
    stored = await gateway.store.get('q-1');
  } finally {
    await gateway.stop();
  }
  // The cancelled message never entered durable history and the session
  // was not marked failed by work that never ran.
  assert.deepEqual(stored?.messages.filter((m) => m.role === 'user').map((m) => m.content), ['first']);
  assert.equal(stored?.status, 'completed');
});

test('channel adapters start after the roster and stop before the drain', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  const order: string[] = [];
  let sawAgentsAtStart = 0;
  let replied = '';

  const adapter = {
    name: 'fake',
    async start(gw: import('../src/index.ts').Gateway) {
      order.push('start');
      sawAgentsAtStart = gw.agents().length;
      // A full end-to-end turn through the real gateway from a channel.
      const session = await gw.dispatch({ sessionId: 'chan-1', userMessage: 'say hello' });
      replied = session.messages.at(-1)?.content ?? '';
    },
    async stop() {
      order.push('stop');
    },
  };

  const gateway = createGateway({ env, idleTimeoutMs: 0, channels: [adapter] });
  await gateway.start();
  await gateway.stop();

  assert.deepEqual(order, ['start', 'stop']);
  assert.ok(sawAgentsAtStart >= 1, 'roster must be loaded before channels start');
  assert.ok(replied.length > 0, 'the channel turn produced a reply');
});

test('a channel adapter that fails to start does not take the gateway down', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const warnings: string[] = [];

  const broken = {
    name: 'broken',
    async start() {
      throw new Error('no tokens');
    },
    async stop() {
      throw new Error('never started');
    },
  };

  const gateway = createGateway({ env, idleTimeoutMs: 0, channels: [broken], warn: (line) => warnings.push(line) });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'still-up-1', userMessage: 'say hello' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.ok(warnings.some((line) => line.includes('broken')), 'expected a warning about the broken channel');
});

test('an adapter whose start rejects is still cleaned up', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  // start() acquires a resource (a socket, a listener) and THEN fails: it
  // never reaches the started list, so the failure path must stop it —
  // nothing else ever will.
  let cleanedUp = false;
  const halfStarted = {
    name: 'half-started',
    async start() {
      throw new Error('failed after acquiring a socket');
    },
    async stop() {
      cleanedUp = true;
    },
  };

  const gateway = createGateway({ env, idleTimeoutMs: 0, channels: [halfStarted], warn: () => {} });
  await gateway.start();
  await gateway.stop();

  assert.equal(cleanedUp, true, 'the failed adapter must be stopped in the failure path');
});

test('a required adapter that cannot start fails the gateway start and stops the channels before it', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  // The control API's shape: a second daemon on a home loses the port to
  // the first. Logged and skipped, that daemon went on serving with no
  // channel at all, and the next scheduled firing ran in it. Required, the
  // failure is the gateway's, and the channels already up come down with
  // it — a daemon that will not serve must not hold a Slack socket open.
  const stops: string[] = [];
  const first = {
    name: 'first',
    async start() {},
    async stop() {
      stops.push('first');
    },
  };
  const port = {
    name: 'port',
    required: true,
    async start() {
      throw new Error('address already in use');
    },
    async stop() {
      stops.push('port');
    },
  };
  const warnings: string[] = [];

  const gateway = createGateway({ env, idleTimeoutMs: 0, channels: [first, port], warn: (line) => warnings.push(line) });
  try {
    await assert.rejects(gateway.start(), /port could not start, and the gateway cannot serve without it: address already in use/);

    assert.deepEqual(stops.sort(), ['first', 'port'], 'the failed adapter is cleaned up and the started one is stopped');
    // The failure is the rejection, not a warning beside a daemon that keeps
    // going: nothing here should read as "serving anyway".
    assert.ok(!warnings.some((line) => line.includes('failed to start')), warnings.join('\n'));
    // And nothing stays open: a start that rejects never reaches its
    // caller's stop(), so the stores the constructor opened close with it
    // — a host retrying a port it cannot bind would otherwise leak
    // descriptors on every attempt. The stop() below is still allowed
    // after that, and closes nothing twice.
    await assert.rejects(gateway.store.get('nothing'), /not open/);
  } finally {
    // Also the losing path: a start that resolved instead has a scheduler
    // ticking, and only a stop lets the suite end.
    await gateway.stop();
  }
});

test('a start that fails after a channel parked an approval denies it before that channel is stopped', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  let transport: ApprovalTransport | undefined;

  // A channel up before the required one fails has parked a gated turn on
  // a person — buttons showing somewhere. The failed start is a shutdown,
  // and a shutdown denies what is parked and lets the denial reach the
  // channel before stopping it, or the buttons stay up for a turn that is
  // over. Stopping the channel first, as the failure path once did, is the
  // one order that loses that.
  const order: string[] = [];
  let parked: Promise<unknown> | undefined;
  const early: GatewayChannelAdapter = {
    name: 'early',
    async start(gateway) {
      gateway.bus.subscribe((event) => {
        if (event.type === 'tool.approval-resolved') {
          order.push(`resolved:${event.reason}`);
        }
      });
      assert.ok(transport, 'the approvals factory ran before the channels started');
      parked = transport.request(parkedCall('parked-in-start'));
    },
    async stop() {
      order.push('early stopped');
    },
  };
  const port = {
    name: 'port',
    required: true,
    async start() {
      throw new Error('address already in use');
    },
    async stop() {},
  };

  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    approvalTimeoutMs: 0,
    channels: [early, port],
    warn: () => {},
    approvals: (given) => {
      transport = given;
      return { async approve() { return true; } };
    },
  });
  try {
    await assert.rejects(gateway.start(), /port could not start/);
    assert.ok(parked, 'the early channel parked a request');
    assert.equal((await settles(parked as Promise<{ answer: string }>, 'the parked request')).answer, 'deny');
    assert.deepEqual(order, ['resolved:cancelled', 'early stopped']);
  } finally {
    await gateway.stop();
  }
});

test('a start that fails after a channel accepted a turn lets that turn finish before the store closes', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  // A channel that is up before the required one fails can already have
  // dispatched — a Slack message arriving in the window. Closing the store
  // under that turn would fail it on its own save; the failed start is a
  // shutdown, so it drains first, the way stop() does.
  let turn: Promise<unknown> | undefined;
  const early: GatewayChannelAdapter = {
    name: 'early',
    async start(gateway) {
      turn = gateway.dispatch({ sessionId: 'accepted-1', userMessage: 'say hello' });
    },
    async stop() {},
  };
  const port = {
    name: 'port',
    required: true,
    async start() {
      throw new Error('address already in use');
    },
    async stop() {},
  };

  const gateway = createGateway({ env, idleTimeoutMs: 0, channels: [early, port], warn: () => {} });
  try {
    await assert.rejects(gateway.start(), /port could not start/);
    assert.ok(turn, 'the early channel dispatched');
    const session = await turn as { status: string; lastError?: string };
    assert.equal(session.status, 'completed', session.lastError);
    await assert.rejects(gateway.store.get('accepted-1'), /not open/);
  } finally {
    await gateway.stop();
  }
});

test('the idle watchdog honors a session sticky-switched to a non-streaming fallback', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // Anthropic primary (streams → watchdog eligible) with an OpenAI
  // fallback (no deltas): once a session has durably switched, the
  // watchdog must stay off for it or slow-but-healthy fallback turns die.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'openai',
  }));

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('anthropic')) {
      throw new Error('primary should not be called for a switched session');
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    return openAiText('slow but healthy fallback');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 100, warn: () => {} });
  await gateway.start();

  // A durable session that already switched to the fallback.
  await gateway.store.create({
    id: 'switched-1',
    agent: { id: 'stratus', name: 'Stratus' },
    status: 'completed',
    messages: [
      { id: 'u1', role: 'user', content: 'earlier', createdAt: new Date().toISOString() },
      { id: 'a1', role: 'assistant', content: 'earlier reply', createdAt: new Date().toISOString() },
    ],
    metadata: { fallbackActive: true },
  });

  const session = await gateway.dispatch({ sessionId: 'switched-1', userMessage: 'take your time' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /slow but healthy fallback/);
});

test('the watchdog suspends across a slow tool phase and re-arms for the next provider call', async () => {
  const home = await newHome();
  // A streaming primary calls agent.delegate; the delegated agent's provider
  // takes longer than the idle timeout. The tool phase emits no deltas, so
  // the watchdog must suspend at provider.response and only re-arm once the
  // tool settles — otherwise every slow tool or approval wait dies at the
  // idle timeout.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\ndelegates:\n  - bea\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');

  // Two independent constraints, and the first is the one a contended CI
  // runner breaks. An armed window here holds real work — soul loading,
  // the session write, building the provider — which measures in single
  // milliseconds locally and can stretch by an order of magnitude under a
  // loaded runner, so the timeout has to sit far above it, not just above
  // it. The slow phase then only has to outlast the timeout to prove the
  // suspension, which doubling covers with room to spare.
  const IDLE_MS = 500;

  let anthropicCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      anthropicCalls += 1;
      return anthropicCalls === 1
        ? anthropicSseToolCall('agent_delegate', { agent: 'bea', prompt: 'take your time' })
        : anthropicSseText('bea finally answered');
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
    return openAiText('slow but healthy delegate');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: IDLE_MS, warn: () => {} });
  await gateway.start();

  const session = await gateway.dispatch({ sessionId: 'tool-phase-1', agentId: 'ava', userMessage: 'delegate this' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.equal(anthropicCalls, 2);
  assert.match(session.messages.at(-1)?.content ?? '', /bea finally answered/);
});

test('a mid-turn switch to a non-streaming fallback suspends the watchdog for the turn', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The primary dies before the session ever recorded a durable switch, so
  // this turn started watchdog-eligible. The reset delta emitted at the
  // switch must suspend the timer: the OpenAI fallback emits no deltas, and
  // its slow-but-healthy turn would otherwise be killed as a stall.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'openai',
  }));

  // Same margin as the tool-phase test above, and for the same reason: the
  // window between arming and the primary's failure holds real work.
  const IDLE_MS = 500;

  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      // A 400 fails the primary immediately — the SDK does not retry it,
      // so the switch happens while the watchdog is still freshly armed.
      return new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'primary down' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
    return openAiText('fallback rode out the silence');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: IDLE_MS, warn: () => {} });
  await gateway.start();

  const session = await gateway.dispatch({ sessionId: 'mid-turn-1', userMessage: 'hang in there' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /fallback rode out the silence/);
});

test('a soul provider pin beats the gateway-wide selection', async () => {
  const home = await newHome();
  // The gateway's selection is a default for unpinned agents, never an
  // override: Ava pins Anthropic, so she must not be routed through the
  // gateway's OpenAI default — nor inherit its model.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('anthropic')) {
      return anthropicSseText('from anthropic');
    }
    return openAiText('from openai');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'openai', model: 'model-o' },
  });
  await gateway.start();

  const pinned = await gateway.dispatch({ sessionId: 'pin-1', agentId: 'ava', userMessage: 'hi' });
  // The default agent has no pins, so the gateway-wide selection applies.
  const unpinned = await gateway.dispatch({ sessionId: 'pin-2', userMessage: 'hi' });
  await gateway.stop();

  assert.match(pinned.messages.at(-1)?.content ?? '', /from anthropic/);
  assert.match(unpinned.messages.at(-1)?.content ?? '', /from openai/);
  assert.ok(urls.some((url) => url.includes('anthropic')));
});

test('the watchdog re-arms after a rejected tool call and still catches a stalled provider', async () => {
  const home = await newHome();
  // The streaming provider calls a tool that does not exist; the kernel
  // rejects it without executing anything. The rejection must still settle
  // the watchdog's pending-tool count — otherwise the timer stays
  // suspended, and the stalled second provider request below would hang
  // the turn (and gateway shutdown) forever.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  let anthropicCalls = 0;
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    if (String(url).includes('anthropic')) {
      anthropicCalls += 1;
      if (anthropicCalls === 1) {
        return Promise.resolve(anthropicSseToolCall('no_such_tool', {}));
      }
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(openAiText('unused'));
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { ANTHROPIC_API_KEY: 'sk-a' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 200, warn: () => {} });
  await gateway.start();

  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'rejected-tool-1', agentId: 'ava', userMessage: 'call something odd' }),
    (error: Error) => error instanceof RunAbortedError && /no activity/.test(error.message),
  );
  await gateway.stop();
  assert.equal(anthropicCalls, 2);
});

test('a soul provider pin beats the daemon environment defaults', async () => {
  const home = await newHome();
  // STRATUS_PROVIDER / STRATUS_MODEL inherited by the daemon's process are
  // defaults with the same standing as the gateway selection — a soul
  // pinned to another provider must not be routed through them.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('anthropic')) {
      return anthropicSseText('from anthropic');
    }
    return openAiText('from openai');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: {
      STRATUS_PROVIDER: 'openai',
      STRATUS_MODEL: 'model-env',
      ANTHROPIC_API_KEY: 'sk-a',
      OPENAI_API_KEY: 'sk-o',
    },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const pinned = await gateway.dispatch({ sessionId: 'env-pin-1', agentId: 'ava', userMessage: 'hi' });
  // The unpinned default agent still follows the environment default.
  const unpinned = await gateway.dispatch({ sessionId: 'env-pin-2', userMessage: 'hi' });
  await gateway.stop();

  assert.match(pinned.messages.at(-1)?.content ?? '', /from anthropic/);
  assert.match(unpinned.messages.at(-1)?.content ?? '', /from openai/);
  assert.ok(urls.some((url) => url.includes('anthropic')));
});

test('endpoint and generic credential defaults never ride along to a soul-pinned provider', async () => {
  const home = await newHome();
  // The daemon's defaults point at a custom OpenAI-compatible endpoint
  // with a generic key. Ava pins Anthropic: her requests must go to the
  // real Anthropic endpoint with her provider's credential — the default
  // base URL and generic key were chosen for a different service.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('api.anthropic.com')) {
      return anthropicSseText('anthropic answered');
    }
    return openAiText('local endpoint answered');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: {
      STRATUS_API_KEY: 'sk-generic',
      ANTHROPIC_API_KEY: 'sk-a',
      OPENAI_API_KEY: 'sk-o',
    },
    fetch: fetchImpl,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'openai', baseUrl: 'http://localhost:9/v1' },
  });
  await gateway.start();

  const pinned = await gateway.dispatch({ sessionId: 'endpoint-pin-1', agentId: 'ava', userMessage: 'hi' });
  await gateway.stop();

  assert.match(pinned.messages.at(-1)?.content ?? '', /anthropic answered/);
  assert.ok(urls.every((url) => !url.includes('localhost')));
});

test('the watchdog arms when a streaming fallback takes over a non-streaming primary', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The primary emits no deltas, so the turn starts with the watchdog
  // unarmed. When the primary fails and the Anthropic fallback takes over
  // mid-turn, the reset delta must arm it: a fallback stream that then
  // stalls has to be cut loose, not held open until an SDK timeout.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'anthropic',
  }));

  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    if (String(url).includes('anthropic')) {
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(new Response(
      JSON.stringify({ error: { message: 'primary down' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ));
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 300, warn: () => {} });
  await gateway.start();

  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'arming-1', userMessage: 'hang after switching' }),
    (error: Error) => error instanceof RunAbortedError && /no activity/.test(error.message),
  );
  await gateway.stop();
});

test('a dispatch aborted during preflight never touches durable state', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  // The entry check runs first (microtask FIFO), then preflight awaits
  // filesystem work, then this abort fires — landing squarely between the
  // entry check and the runner. The recheck must catch it before any
  // session is created.
  const controller = new AbortController();
  const pending = gateway.dispatch({
    sessionId: 'preflight-abort-1',
    userMessage: 'never me',
    signal: controller.signal,
  });
  queueMicrotask(() => controller.abort());

  await assert.rejects(() => pending, (error: Error) => error instanceof RunAbortedError);
  const stored = await gateway.store.get('preflight-abort-1');
  await gateway.stop();
  assert.equal(stored, undefined);
});

test('an agentId-less dispatch answers as the configured default soul', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // What `stratus setup` writes: a default soul outside the roster dir.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova, precise and quick.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  // The default soul is part of the visible roster.
  assert.ok(gateway.agents().some((agent) => agent.name === 'Nova'), 'the default soul must appear in agents()');

  // No agentId: the turn runs AS Nova — identity, not just provider config.
  const session = await gateway.dispatch({ sessionId: 'default-soul-1', userMessage: 'hello' });
  await gateway.stop();

  assert.equal(session.agent.name, 'Nova');
  assert.notEqual(session.agent.id, 'stratus');
  assert.equal(session.status, 'completed');
});

test('a configured default soul that would share a roster agent\'s directory is ignored', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  // A roster agent, and a config-only default declaring the same id in
  // another case. `loadRosterSouls` folds ids against each other, but it
  // never sees this soul — it is resolved by path and registered by exact
  // id — so the two would open one `agents/<id>/`: one sessions.db, one
  // memory.jsonl, and one whitelist.json saying what may run unattended.
  await writeFile(
    path.join(home, '.stratus', 'agents', 'ava.md'),
    '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n',
  );
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nid: Ava\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();

  // Dropped, not served: an agentId-less dispatch falls back to the
  // built-in, which is the documented answer when there is no usable
  // default — rather than running as a second agent on Ava's state.
  const session = await gateway.dispatch({ sessionId: 'folded-default-1', userMessage: 'hello' });
  await gateway.stop();

  assert.equal(session.agent.id, 'stratus');
  assert.match(warnings.join(' '), /same state directory as ava/);
  assert.match(warnings.join(' '), /rename one of the two ids/);
  // And the roster agent is untouched — this refuses the newcomer, it does
  // not take the established agent down.
  assert.ok(gateway.agents().some((agent) => agent.id === 'ava'), 'ava stays on the roster');
});

test('a config-only default soul keeps its provider pin over the gateway selection', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The default soul lives outside the roster dir and pins Anthropic; the
  // gateway was started with an OpenAI-wide default. The pin must win.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('anthropic')) {
      return anthropicSseText('nova on anthropic');
    }
    return openAiText('wrong provider');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'openai', model: 'model-o' },
  });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'config-soul-pin-1', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.agent.name, 'Nova');
  assert.match(session.messages.at(-1)?.content ?? '', /nova on anthropic/);
  assert.ok(urls.every((url) => !url.includes('openai')));
});

test('a roster-backed default soul keeps its soulPath (and its pins) when registered as default', async () => {
  const home = await newHome();
  // The normal setup layout: the default soul IS a roster soul. Its
  // registration as the default must not shed the soulPath that drives
  // per-dispatch refresh and pin demotion.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: '.stratus/agents/ava.md' }));

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('anthropic')) {
      return anthropicSseText('ava on anthropic');
    }
    return openAiText('wrong provider');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'openai', model: 'model-o' },
  });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'roster-default-1', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.agent.name, 'Ava');
  assert.match(session.messages.at(-1)?.content ?? '', /ava on anthropic/);
  assert.ok(urls.every((url) => !url.includes('openai')));
});

test('an agentId-less session resumes with its stored agent after the default soul changes', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, 'mira.md'), '---\nname: Mira\n---\n\nYou are Mira.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const opened = await gateway.dispatch({ sessionId: 'sticky-default-1', userMessage: 'hello' });
  assert.equal(opened.agent.name, 'Nova');

  // The operator repoints the default soul mid-flight. The existing
  // conversation keeps its pinned agent; a NEW session takes the new one.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'mira.md' }));

  const resumed = await gateway.dispatch({ sessionId: 'sticky-default-1', userMessage: 'still you?' });
  const fresh = await gateway.dispatch({ sessionId: 'sticky-default-2', userMessage: 'hello' });
  await gateway.stop();

  assert.equal(resumed.agent.name, 'Nova');
  assert.equal(resumed.status, 'completed');
  assert.equal(
    resumed.messages.filter((m) => m.role === 'user').length,
    2,
    'the conversation must continue, not restart',
  );
  assert.equal(fresh.agent.name, 'Mira');
});

test('an edited config-only default soul reaches resumed sessions on their next turn', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova, mark one.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const opened = await gateway.dispatch({ sessionId: 'edited-default-1', userMessage: 'hello' });
  assert.match(opened.agent.instructions ?? '', /mark one/);

  // Edit the soul in place (same identity). The next turn of the SAME
  // session must run with the new persona — a config-only soul refreshes
  // per dispatch exactly like a roster soul.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova, mark two.\n');
  const resumed = await gateway.dispatch({ sessionId: 'edited-default-1', userMessage: 'and now?' });
  await gateway.stop();

  assert.equal(resumed.agent.name, 'Nova');
  assert.match(resumed.agent.instructions ?? '', /mark two/);
});

test('a soul file reassigned to a different agent id refuses dispatches for the old id', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  const fetchImpl = (async () => openAiText('hi from ava')) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  const opened = await gateway.dispatch({ sessionId: 'reassigned-1', agentId: 'ava', userMessage: 'hello' });
  assert.equal(opened.status, 'completed');

  // The operator rewrites the file as a different agent. Ava's sessions
  // must not silently run on Zed's provider pins — the dispatch refuses
  // with a clear error instead.
  await writeSoul(home, 'ava.md', '---\nname: Zed\nprovider: anthropic\nmodel: model-z\n---\n\nYou are Zed.\n');
  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'reassigned-1', agentId: 'ava', userMessage: 'still ava?' }),
    /now declares agent .*not ava/,
  );

  // Restoring the identity restores service.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava again.\n');
  const recovered = await gateway.dispatch({ sessionId: 'reassigned-1', agentId: 'ava', userMessage: 'back?' });
  await gateway.stop();
  assert.equal(recovered.status, 'completed');
});

test('a temporarily unreadable soul degrades to the cached definition and pins', async () => {
  const { unlink } = await import('node:fs/promises');
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  // A configured default soul with its own model: Ava's degraded
  // resolution must not fall back to it.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nprovider: openai\nmodel: model-nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const requestedModels: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(body.model);
    return openAiText(`reply from ${body.model}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  const first = await gateway.dispatch({ sessionId: 'degraded-1', agentId: 'ava', userMessage: 'hello' });
  assert.equal(first.status, 'completed');

  // The soul file vanishes mid-flight (partial edit, sync glitch): the
  // agent keeps serving from cache instead of failing every dispatch.
  await unlink(path.join(home, '.stratus', 'agents', 'ava.md'));
  const degraded = await gateway.dispatch({ sessionId: 'degraded-1', agentId: 'ava', userMessage: 'still here?' });
  await gateway.stop();

  assert.equal(degraded.status, 'completed');
  assert.equal(degraded.agent.name, 'Ava');
  // Both turns ran on Ava's own cached model — never the default soul's.
  assert.deepEqual(requestedModels, ['model-a', 'model-a']);
});

test('the watchdog observes activity ahead of slow external event consumers', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'provider: anthropic', 'model: model-a',
    'tools:', '  - agent.delegate', 'delegates:', '  - bea', '---', '', 'You are Ava.', '',
  ].join('\n'));
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');

  let anthropicCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      anthropicCalls += 1;
      return anthropicCalls === 1
        ? anthropicSseToolCall('agent_delegate', { agent: 'bea', prompt: 'quick task' })
        : anthropicSseText('all done');
    }
    return openAiText('bea done');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  // Same margin as the other two tests that arm the watchdog and then
  // require it to suspend: the armed window before the first delta holds
  // real work, which measures in single milliseconds here and stretches by
  // an order of magnitude on a loaded runner. This is the test that
  // actually lost that race in CI.
  const IDLE_MS = 500;
  const gateway = createGateway({ env, idleTimeoutMs: IDLE_MS, warn: () => {} });
  await gateway.start();

  // An external consumer (think: a throttled channel edit) that takes
  // longer than the idle timeout to process provider.response. Emission
  // awaits subscribers in order — the watchdog must observe (and suspend)
  // BEFORE this consumer blocks the chain, or a healthy turn dies.
  gateway.bus.subscribe(async (event) => {
    if (event.type === 'provider.response') {
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
    }
  });

  const session = await gateway.dispatch({ sessionId: 'slow-consumer-1', agentId: 'ava', userMessage: 'delegate it' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /all done/);
});

test('a pinless cached soul never inherits the default soul\'s pins while unreadable', async () => {
  const { unlink } = await import('node:fs/promises');
  const home = await newHome();
  // Ava has NO provider/model pins; the configured default soul does.
  await writeSoul(home, 'ava.md', '---\nname: Ava\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nprovider: openai\nmodel: model-nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const requestedModels: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(body.model);
    return openAiText('should not be called for ava');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  const first = await gateway.dispatch({ sessionId: 'pinless-1', agentId: 'ava', userMessage: 'hello' });
  assert.equal(first.status, 'completed');

  await unlink(path.join(home, '.stratus', 'agents', 'ava.md'));
  const degraded = await gateway.dispatch({ sessionId: 'pinless-1', agentId: 'ava', userMessage: 'still?' });
  await gateway.stop();

  assert.equal(degraded.status, 'completed');
  assert.equal(degraded.agent.name, 'Ava');
  // A pinless soul resolves the same way readable or not — and NEVER
  // through the default soul's provider/model.
  assert.ok(!requestedModels.includes('model-nova'), `default soul pins leaked: ${JSON.stringify(requestedModels)}`);
});

test('repointing the default soul to a new file with the same id takes effect', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova, mark one.\n');
  await writeFile(path.join(home, 'nova-v2.md'), '---\nname: Nova\n---\n\nYou are Nova, mark two.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const opened = await gateway.dispatch({ sessionId: 'repoint-1', userMessage: 'hello' });
  assert.match(opened.agent.instructions ?? '', /mark one/);

  // A replacement file, same identity: the source must follow the new
  // path instead of silently refreshing the old one forever.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova-v2.md' }));
  const fresh = await gateway.dispatch({ sessionId: 'repoint-2', userMessage: 'hello again' });
  await gateway.stop();

  assert.match(fresh.agent.instructions ?? '', /mark two/);
});

test('the watchdog does not tick while slow delta consumers process a healthy stream', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      return anthropicSseText('healthy but slowly consumed');
    }
    return openAiText('unused');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { ANTHROPIC_API_KEY: 'sk-a' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 300, warn: () => {} });
  await gateway.start();

  // A throttled consumer that takes longer than the idle timeout per
  // delta. The provider awaits the sink (backpressure), so no further
  // delta can arrive until this finishes — that elapsed time is consumer
  // time, not provider silence, and must not be counted against the turn.
  gateway.bus.subscribe(async (event) => {
    if (event.type === 'provider.delta') {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  const session = await gateway.dispatch({ sessionId: 'slow-delta-1', agentId: 'ava', userMessage: 'stream it' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /healthy but slowly consumed/);
});

test('the gateway starts when daemon defaults lack credentials the default soul does not need', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeSoul(home, 'roster-bea.md', '---\nname: Bea\nprovider: anthropic\nmodel: model-b\n---\n\nYou are Bea.\n');
  // The default soul pins Anthropic; the daemon-wide default says OpenAI —
  // and only Anthropic credentials are installed. Startup must not fail
  // on the OpenAI key the soul never needed.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nprovider: anthropic\nmodel: model-n\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      return anthropicSseText('nova on anthropic');
    }
    return openAiText('unexpected provider');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, selection: { provider: 'openai' } });

  // Previously this threw "Missing API key" out of loadRoster.
  await gateway.start();
  assert.ok(gateway.agents().some((agent) => agent.name === 'Nova'));

  // The default route runs on the soul's own provider...
  const viaDefault = await gateway.dispatch({ sessionId: 'start-degrade-1', userMessage: 'hi' });
  assert.equal(viaDefault.agent.name, 'Nova');
  assert.match(viaDefault.messages.at(-1)?.content ?? '', /nova on anthropic/);

  // ...and explicit roster agents were never held hostage by the default.
  const viaRoster = await gateway.dispatch({ sessionId: 'start-degrade-2', agentId: 'bea', userMessage: 'hi' });
  await gateway.stop();
  assert.equal(viaRoster.status, 'completed');
});

test('an unreadable default soul path degrades startup instead of failing it', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'missing.md' }));

  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();

  // The default route falls back to the built-in agent, with a warning.
  const session = await gateway.dispatch({ sessionId: 'missing-default-1', userMessage: 'hello' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.equal(session.agent.id, 'stratus');
  assert.ok(warnings.some((line) => line.includes('default soul')), `expected a default-soul warning, got ${JSON.stringify(warnings)}`);
});

test('a malformed config.json degrades dispatches instead of failing them', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova.\n');

  const fetchImpl = (async () => openAiText('ava fine')) as typeof fetch;
  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();

  const healthy = await gateway.dispatch({ sessionId: 'cfg-degrade-0', userMessage: 'hi' });
  assert.equal(healthy.agent.name, 'Nova');

  // The operator saves config.json mid-edit: invalid JSON. The daemon
  // keeps serving — roster agents from their own pins, the default route
  // from its cached source — with a warning, not a dead gateway.
  await writeFile(path.join(home, '.stratus', 'config.json'), '{ "soul": ');

  const roster = await gateway.dispatch({ sessionId: 'cfg-degrade-1', agentId: 'ava', userMessage: 'hi' });
  assert.equal(roster.status, 'completed');
  assert.match(roster.messages.at(-1)?.content ?? '', /ava fine/);

  const viaDefault = await gateway.dispatch({ sessionId: 'cfg-degrade-2', userMessage: 'hi' });
  await gateway.stop();
  assert.equal(viaDefault.status, 'completed');
  assert.equal(viaDefault.agent.name, 'Nova');
  assert.ok(warnings.some((line) => line.includes('config')), `expected a config warning, got ${JSON.stringify(warnings)}`);
});

test('generic credentials survive when the soul pins the config-file provider', async () => {
  const home = await newHome();
  // The daemon default comes ONLY from the config file, and the soul pins
  // that same provider. The generic key installed for it must survive.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));

  const authHeaders: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    authHeaders.push(headers.get('x-api-key') ?? '');
    if (String(url).includes('anthropic')) {
      return anthropicSseText('ava with the generic key');
    }
    return openAiText('unexpected');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { STRATUS_API_KEY: 'sk-generic' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  // Previously this failed with "Missing API key": no selection/env
  // provider default meant the scrub always fired.
  const session = await gateway.dispatch({ sessionId: 'cfg-provider-1', agentId: 'ava', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /ava with the generic key/);
  assert.ok(authHeaders.some((header) => header === 'sk-generic'));
});

test('the sticky-fallback switch is durable while the fallback is still in flight', { timeout: 20_000 }, async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'openai',
  }));

  // A gate, not a sleep: the wrapper persists the switch before it calls
  // the fallback, so blocking the fallback's first byte pins the exact
  // window the assertion is about. A timed race here passes locally and
  // flakes on a loaded runner, which is a property of the clock rather
  // than of the code under test.
  let fallbackReached = (): void => {};
  const fallbackInFlight = new Promise<void>((resolve) => {
    fallbackReached = () => resolve();
  });
  let releaseFallback = (): void => {};
  const fallbackReleased = new Promise<void>((resolve) => {
    releaseFallback = () => resolve();
  });

  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      return new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'primary down' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    // The fallback hangs until the test has read the store: the switch
    // must already be durable while the fallback is still in flight.
    fallbackReached();
    await fallbackReleased;
    return openAiText('slow fallback reply');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  const pending = gateway.dispatch({ sessionId: 'durable-switch-1', userMessage: 'go' });
  // The gate also loses to the dispatch settling. A regression that never
  // reaches the fallback at all — the primary failure surfacing as a failed
  // session, say — would otherwise leave this waiting on a promise nobody
  // resolves, and a hung run reports nothing at all where the assertion
  // below reports exactly what broke.
  await Promise.race([fallbackInFlight, pending.then(() => {}, () => {})]);
  const midFlight = await gateway.store.get('durable-switch-1');
  assert.equal(midFlight?.metadata?.fallbackActive, true, 'the switch must be durable before the fallback returns');

  releaseFallback();
  const session = await pending;
  await gateway.stop();
  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /slow fallback reply/);
});

test('a provider-less legacy config counts as an OpenAI default for the credential scrub', async () => {
  const home = await newHome();
  // Legacy config: no provider key (openai-specific by convention), an
  // OpenAI-pinned soul, and the generic key. The scrub must see a match.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ model: 'model-legacy' }));

  const authHeaders: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    authHeaders.push(String((init?.headers as Record<string, string>)?.authorization ?? ''));
    return openAiText('ava with the generic key');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { STRATUS_API_KEY: 'sk-generic' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const session = await gateway.dispatch({ sessionId: 'legacy-cfg-1', agentId: 'ava', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.ok(authHeaders.some((header) => header === 'Bearer sk-generic'));
});

test('config degradation serves the last known-good config, never the demo default', async () => {
  const home = await newHome();
  // A pinless soul whose provider comes entirely from the config file.
  await writeSoul(home, 'ava.md', '---\nname: Ava\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai', model: 'model-cfg' }));

  const requestedModels: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(body.model);
    return openAiText('real provider reply');
  }) as typeof fetch;

  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();

  const healthy = await gateway.dispatch({ sessionId: 'keepcfg-1', agentId: 'ava', userMessage: 'hi' });
  assert.match(healthy.messages.at(-1)?.content ?? '', /real provider reply/);

  // Mid-edit save: the config is momentarily invalid. The session must
  // keep its configured provider — a canned demo reply durably recorded
  // in a real conversation would be worse than failing.
  await writeFile(path.join(home, '.stratus', 'config.json'), '{ "provider": ');
  const degraded = await gateway.dispatch({ sessionId: 'keepcfg-1', userMessage: 'still openai?' });
  await gateway.stop();

  assert.equal(degraded.status, 'completed');
  assert.match(degraded.messages.at(-1)?.content ?? '', /real provider reply/);
  assert.deepEqual(requestedModels, ['model-cfg', 'model-cfg']);
  assert.ok(warnings.some((line) => line.includes('config')));
});

test('an empty STRATUS_PROVIDER is no default at all for the credential scrub', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));

  const apiKeys: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    apiKeys.push(new Headers(init?.headers ?? {}).get('x-api-key') ?? '');
    if (String(url).includes('anthropic')) {
      return anthropicSseText('still anthropic');
    }
    return openAiText('unexpected');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    // The resolver ignores empty env values; the scrub must too — this
    // previously read '' as a mismatching default and deleted the key.
    processEnv: { STRATUS_PROVIDER: '', STRATUS_API_KEY: 'sk-generic' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'empty-env-1', agentId: 'ava', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /still anthropic/);
  assert.ok(apiKeys.some((key) => key === 'sk-generic'));
});

test('WAL sidecars are owner-only for their whole lifetime, reopens included', async () => {
  const { stat } = await import('node:fs/promises');
  const home = await newHome();
  const dir = path.join(home, 'shared');
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const dbPath = path.join(dir, 'sessions.db');

  const assertSidecarsTight = async (): Promise<void> => {
    for (const sidecar of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      const mode = (await stat(sidecar)).mode & 0o777;
      assert.equal(mode, 0o600, `${path.basename(sidecar)} must be owner-only, was ${mode.toString(8)}`);
    }
  };

  // Fresh database: the sidecars exist (WAL mode, forced write) and are
  // tightened before the constructor returns — later transactions reuse
  // them instead of minting umask-mode rollback journals per write.
  const store = new SqliteSessionStore(dbPath);
  await store.create({ id: 'w1', agent: { id: 'a', name: 'A' }, status: 'running', messages: [] });
  await assertSidecarsTight();
  store.close();

  // Reopen over the existing database: same guarantee.
  const reopened = new SqliteSessionStore(dbPath);
  await reopened.save({
    id: 'w1', agent: { id: 'a', name: 'A' }, status: 'completed', messages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await assertSidecarsTight();
  reopened.close();
});

test('removing the default soul updates the cached default to the built-in', async () => {
  const { unlink } = await import('node:fs/promises');
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  const asNova = await gateway.dispatch({ sessionId: 'retire-1', userMessage: 'hello' });
  assert.equal(asNova.agent.name, 'Nova');

  // The operator retires the default soul on purpose.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({}));
  const asBuiltin = await gateway.dispatch({ sessionId: 'retire-2', userMessage: 'hello' });
  assert.equal(asBuiltin.agent.id, 'stratus');

  // A later transient config failure must not resurrect Nova — the cached
  // default is now the built-in.
  await unlink(path.join(home, '.stratus', 'config.json'));
  await writeFile(path.join(home, '.stratus', 'config.json'), '{ broken');
  const degraded = await gateway.dispatch({ sessionId: 'retire-3', userMessage: 'hello' });
  await gateway.stop();
  assert.equal(degraded.agent.id, 'stratus');
});

test('the generic key serves a pinned soul when nothing else selects a provider', async () => {
  const home = await newHome();
  // No config.json, no env/selection provider: the soul is the only
  // provider selector, so STRATUS_API_KEY is its credential — the
  // resolver's own reading of a generic key.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const apiKeys: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    apiKeys.push(new Headers(init?.headers ?? {}).get('x-api-key') ?? '');
    if (String(url).includes('anthropic')) {
      return anthropicSseText('soul-only selection works');
    }
    return openAiText('unexpected');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { STRATUS_API_KEY: 'sk-generic' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'soul-only-1', agentId: 'ava', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /soul-only selection works/);
  assert.ok(apiKeys.some((key) => key === 'sk-generic'));
});

test('a demo daemon default never sheds the generic key from a pinned soul', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const apiKeys: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    apiKeys.push(new Headers(init?.headers ?? {}).get('x-api-key') ?? '');
    if (String(url).includes('anthropic')) {
      return anthropicSseText('demo default, real soul');
    }
    return openAiText('unexpected');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { STRATUS_API_KEY: 'sk-generic' }, fetch: fetchImpl };
  // The demo provider consumes no credentials, so it cannot be what the
  // generic key was installed for.
  const gateway = createGateway({ env, idleTimeoutMs: 0, selection: { provider: 'demo' } });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'demo-default-1', agentId: 'ava', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /demo default, real soul/);
  assert.ok(apiKeys.some((key) => key === 'sk-generic'));
});

test('a roster soul with no tools: list is named at load, because the omitted key grants every tool', async () => {
  const home = await newHome();
  await writeSoul(home, 'open.md', '---\nname: Open\n---\n\nI have every tool.\n');
  await writeSoul(home, 'narrow.md', '---\nname: Narrow\ntools:\n  - memory.*\n---\n\nI have memory.\n');

  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();
  await gateway.stop();

  const named = warnings.filter((line) => line.includes('has no tools: list'));
  assert.equal(named.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
  assert.match(named[0] ?? '', /agent open has no tools: list, so it may call every tool this daemon loads — add tools: \[\.\.\.\] to .*open\.md to say which/);
  // The built-in agent has no file to add the key to, so it is not named.
  assert.ok(!warnings.some((line) => line.includes('agent stratus has no tools')));
});

test('a config-only default soul with no tools: list is named too, and a roster-backed one only once', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // Outside the roster directory: the one path into the roster that does
  // not pass the roster loop.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));
  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();
  await gateway.stop();
  const named = warnings.filter((line) => line.includes('has no tools: list'));
  assert.deepEqual(named.map((line) => line.replace(/ — add tools:.*$/, '')), [
    'agent nova has no tools: list, so it may call every tool this daemon loads',
  ]);
  assert.match(named[0] ?? '', /to .*nova\.md to say which/);

  // Every roster load, not only the first registration: the promise is a
  // notice each time the roster loads, and a reload re-reads the soul.
  const again = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await again.start();
  await again.reloadRoster();
  await again.stop();
  assert.equal(warnings.filter((line) => line.includes('agent nova has no tools: list')).length, 3);

  // The same soul inside the roster directory, and configured as the
  // default: the roster loop names it, and the default resolution does not
  // name it again.
  const roster = await newHome();
  await writeSoul(roster, 'nova.md', '---\nname: Nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(roster, '.stratus', 'config.json'), JSON.stringify({ soul: '.stratus/agents/nova.md' }));
  const once: string[] = [];
  const second = createGateway({ env: { homeDir: roster, cwd: roster, processEnv: {} }, idleTimeoutMs: 0, warn: (line) => once.push(line) });
  await second.start();
  await second.stop();
  assert.equal(once.filter((line) => line.includes('has no tools: list')).length, 1, JSON.stringify(once));
});

test('a roster soul cannot hijack the reserved built-in agent id', async () => {
  const home = await newHome();
  // A roster file whose name slugifies to the reserved id "stratus".
  await writeSoul(home, 'imposter.md', '---\nname: Stratus\nprovider: openai\nmodel: model-x\n---\n\nI am an imposter.\n');

  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();

  // The agentId-less route stays the documented built-in fallback.
  const session = await gateway.dispatch({ sessionId: 'reserved-1', userMessage: 'who are you' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.agent.instructions ?? '', /Stratus Agent platform/);
  assert.ok(!(session.agent.instructions ?? '').includes('imposter'));
  assert.ok(
    warnings.some((line) => line.includes('reserved for the built-in agent')),
    `expected a reservation warning, got ${JSON.stringify(warnings)}`,
  );
});

// ---- approval brokering ---------------------------------------------------

/**
 * The transport a `remote` policy is handed. Captured through the approvals
 * factory rather than driven through a real turn: every tool the gateway
 * registers today is `safe`, so nothing in the fleet can park a call yet.
 * The seam is what remote approval is made of, and it is testable now —
 * the policy's own half is covered in @stratusagent/permissions.
 */
const brokerHarness = async (
  options: { approvalTimeoutMs?: number; channels?: GatewayChannelAdapter[] } = {},
) => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  let transport: ApprovalTransport | undefined;
  const events: StratusEvent[] = [];
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
    ...(options.channels ? { channels: options.channels } : {}),
    approvals: (given) => {
      transport = given;
      return { async approve() { return true; } };
    },
  });
  gateway.bus.subscribe((event) => {
    events.push(event);
  });
  assert.ok(transport, 'the gateway hands the policy factory its approval transport');
  return { gateway, transport, events };
};

const parkedCall = (sessionId: string, signal?: AbortSignal) => ({
  session: {
    id: sessionId,
    agent: { id: 'ava', name: 'Ava' },
    status: 'running' as const,
    messages: [],
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    metadata: { channel: 'slack', slackChannel: 'C1' },
  },
  call: { id: 'call-1', toolName: 'shell.run', input: { command: 'ls' } },
  risk: 'gated' as const,
  ...(signal ? { signal } : {}),
});

/**
 * Awaits something that only the feature under test can settle, with a way
 * to lose. Every assertion below waits on a request being answered, expired,
 * or cancelled — and a regression in any of those does not produce a wrong
 * value, it produces no value at all. Without this bound the suite would
 * hang instead of failing, which reads as broken infrastructure rather than
 * as the defect it is.
 *
 * The bound is not a timing assertion: 5s is orders of magnitude above what
 * any of these take, so slack on a loaded runner costs nothing and proves
 * exactly the same thing.
 */
const settles = async <T>(work: Promise<T>, what: string): Promise<T> => {
  const hung = Symbol('hung');
  const gaveUp = new Promise<typeof hung>((resolve) => {
    const timer = setTimeout(() => resolve(hung), 5_000);
    timer.unref?.();
  });
  const result = await Promise.race([work, gaveUp]);
  assert.notEqual(result, hung, `${what} never settled`);
  return result as T;
};

/** The first event of a kind, waited for rather than slept toward. */
const nextEvent = <T extends StratusEvent['type']>(
  bus: { subscribe(handler: (event: StratusEvent) => void): () => void },
  type: T,
): Promise<Extract<StratusEvent, { type: T }>> =>
  new Promise((resolve) => {
    const off = bus.subscribe((event) => {
      if (event.type === type) {
        off();
        resolve(event as Extract<StratusEvent, { type: T }>);
      }
    });
  });

test('a parked call is announced, and the answer resumes it', async () => {
  const { gateway, transport, events } = await brokerHarness();

  const requested = nextEvent(gateway.bus, 'tool.approval-requested');
  const answer = transport.request(parkedCall('sess-1'));
  const request = await settles(requested, 'the approval request');


  assert.equal(request.agentId, 'ava');
  assert.equal(request.call.toolName, 'shell.run');
  assert.equal(request.risk, 'gated');
  // The session's metadata rides along so a channel can ask where the turn
  // is actually happening without reaching into the store.
  assert.equal(request.metadata?.slackChannel, 'C1');
  // Present because this harness runs with a real timeout; the field is
  // absent only when there is none, which is a different assertion.
  assert.ok(request.expiresAt, 'the request says when it gives up');
  assert.ok(Date.parse(request.expiresAt) > 0);

  assert.equal(gateway.resolveApproval({ requestId: request.requestId, answer: 'always', actor: 'U9' }), true);
  assert.equal((await settles(answer, 'the parked call')).answer, 'always');

  const resolved = events.find((event) => event.type === 'tool.approval-resolved');
  assert.deepEqual(
    resolved && { answer: resolved.answer, reason: resolved.reason, actor: resolved.actor },
    { answer: 'always', reason: 'decided', actor: 'U9' },
  );

  // A second click on the same buttons finds nothing to decide. This is
  // what stops one request being spent twice — a slow network retrying, or
  // two approvers clicking at once.
  assert.equal(gateway.resolveApproval({ requestId: request.requestId, answer: 'deny' }), false);
  assert.equal(gateway.resolveApproval({ requestId: 'never-existed', answer: 'once' }), false);

  await gateway.stop();
});

test('a request nobody answers expires into a denial', async () => {
  // 1ms, and the assertion gates on the settled request rather than a
  // sleep: the point is that the timeout path denies and says so, not how
  // fast it gets there.
  const { gateway, transport } = await brokerHarness({ approvalTimeoutMs: 1 });

  const resolved = nextEvent(gateway.bus, 'tool.approval-resolved');
  assert.equal((await settles(transport.request(parkedCall('sess-timeout')), 'the expiring request')).answer, 'deny');
  const event = await settles(resolved, 'the resolution event');
  assert.equal(event.reason, 'timeout');
  assert.equal(event.answer, 'deny');
  assert.equal(event.actor, undefined);

  await gateway.stop();
});

test('aborting a turn invalidates its pending approval, and a later click is refused', async () => {
  const { gateway, transport } = await brokerHarness();
  const controller = new AbortController();

  const requested = nextEvent(gateway.bus, 'tool.approval-requested');
  const resolved = nextEvent(gateway.bus, 'tool.approval-resolved');
  const answer = transport.request(parkedCall('sess-abort', controller.signal));
  const request = await settles(requested, 'the approval request');

  controller.abort();
  assert.equal((await settles(answer, 'the cancelled request')).answer, 'deny');
  assert.equal((await settles(resolved, 'the resolution event')).reason, 'cancelled');

  // The acceptance criterion this exists for: an Allow arriving after the
  // turn was cancelled must not execute a tool for work that is gone.
  assert.equal(gateway.resolveApproval({ requestId: request.requestId, answer: 'once', actor: 'U9' }), false);

  await gateway.stop();
});

test('a turn already aborted never parks at all', async () => {
  const { gateway, transport, events } = await brokerHarness();
  const controller = new AbortController();
  controller.abort();

  assert.equal(
    (await settles(transport.request(parkedCall('sess-pre-abort', controller.signal)), 'the request')).answer,
    'deny',
  );
  // It still settles publicly: a denial that appears nowhere is exactly
  // what the event log exists to prevent.
  assert.equal(events.filter((event) => event.type === 'tool.approval-resolved').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool.approval-requested').length, 0);

  await gateway.stop();
});

test('shutting down denies what is parked instead of waiting it out', async () => {
  // No timeout at all, so nothing but the shutdown denial can ever settle
  // this request — which is the bug: a daemon must not be held open by a
  // question nobody is going to answer.
  const { gateway, transport } = await brokerHarness({ approvalTimeoutMs: 0 });
  await gateway.start();

  const requested = nextEvent(gateway.bus, 'tool.approval-requested');
  const answer = transport.request(parkedCall('sess-shutdown'));
  const request = await settles(requested, 'the approval request');

  await settles(gateway.stop(), 'the shutdown drain');

  assert.equal((await settles(answer, 'the parked call')).answer, 'deny');
  assert.equal(gateway.resolveApproval({ requestId: request.requestId, answer: 'once' }), false);
});

test('a resolution emitted at shutdown reaches channels before they stop', async () => {
  // EventBus awaits its subscribers in registration order, so one async
  // handler in front of a channel suspends the emission before the channel
  // sees it. Nothing in the daemon is async there today — which is the
  // point: without draining, this guarantee holds by accident, and the
  // first async subscriber anyone adds leaves live-looking approval
  // buttons in a workspace the daemon has already left.
  const seen: string[] = [];
  let sawResolutionBeforeStop: boolean | undefined;

  const channel: GatewayChannelAdapter = {
    name: 'fake',
    async start(gateway) {
      gateway.bus.subscribe((event) => {
        if (event.type === 'tool.approval-resolved') {
          seen.push(event.requestId);
        }
      });
    },
    async stop() {
      sawResolutionBeforeStop = seen.length > 0;
    },
  };

  const { gateway, transport } = await brokerHarness({ approvalTimeoutMs: 0, channels: [channel] });
  // Registered before the channel's (channels subscribe during start), and
  // async, so the emission suspends here first.
  gateway.bus.subscribe(async (event) => {
    if (event.type === 'tool.approval-resolved') {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  await gateway.start();

  const requested = nextEvent(gateway.bus, 'tool.approval-requested');
  const answer = transport.request(parkedCall('sess-drain'));
  await settles(requested, 'the approval request');

  await settles(gateway.stop(), 'the shutdown drain');
  assert.equal((await settles(answer, 'the parked call')).answer, 'deny');
  assert.equal(sawResolutionBeforeStop, true, 'the channel stopped before its retraction arrived');
});

test('a call that reaches approval during shutdown is refused, not parked', async () => {
  // stop() denies what is parked once, at the top. Turns already running
  // keep going through the drain though, and one can reach a gated tool
  // AFTER that snapshot — a provider call finishing, or the next call in
  // the same response. Parking it deadlocks the drain against a question
  // nobody is left to answer. A channel's stop() runs at exactly that
  // point in the sequence, which makes it the honest place to fire one.
  let late: Promise<ApprovalOutcome> | undefined;
  const channel: GatewayChannelAdapter = {
    name: 'fake',
    async start() {},
    async stop() {
      late = transport.request(parkedCall('sess-late'));
    },
  };

  // No timeout at all, so nothing but the fix can ever settle this.
  const harness = await brokerHarness({ approvalTimeoutMs: 0, channels: [channel] });
  const { gateway } = harness;
  const transport = harness.transport;
  await gateway.start();

  await settles(gateway.stop(), 'the shutdown drain');
  assert.ok(late, 'the channel fired a late request');
  assert.equal((await settles(late, 'the late request')).answer, 'deny');
});

test('an approval timeout past the timer range is clamped, not silently instant', async () => {
  // setTimeout turns anything above ~24.8 days into a 1ms delay, so an
  // over-large value would expire every approval almost immediately — the
  // exact opposite of what it asked for.
  const home = await newHome();
  const warnings: string[] = [];
  let transport: ApprovalTransport | undefined;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    approvalTimeoutMs: 2_592_000_000,
    warn: (line) => warnings.push(line),
    approvals: (given) => {
      transport = given;
      return { async approve() { return true; } };
    },
  });

  const requested = nextEvent(gateway.bus, 'tool.approval-requested');
  const answer = transport!.request(parkedCall('sess-clamp'));
  const request = await settles(requested, 'the approval request');

  assert.ok(warnings.some((line) => line.includes('maximum timer delay')), `expected a clamp warning, got ${JSON.stringify(warnings)}`);

  // Not a race and not a sleep-then-check: timers fire in expiry order, so
  // a 1ms one — what an unclamped 30 days silently becomes — has certainly
  // fired by the time a 20ms one does. Reaching this line with the request
  // still resolvable is proof the expiry did not happen. Asserting on
  // `expiresAt` instead would pass either way: the overflow is in
  // setTimeout, not in the arithmetic.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    gateway.resolveApproval({ requestId: request.requestId, answer: 'deny' }),
    true,
    'the request had already expired, so the timeout overflowed to ~1ms',
  );
  assert.equal((await settles(answer, 'the parked call')).answer, 'deny');
  await gateway.stop();
});

test('an approval timeout that is not a number of milliseconds is refused', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  // Both of these fail the `> 0` test and silently mean "never expire" —
  // the one behavior documented for an explicit 0, and the last thing a
  // caller who typed a bad number wants. Config values are rejected with a
  // better message; this is the programmatic path.
  for (const approvalTimeoutMs of [-1, Number.NaN]) {
    assert.throws(
      () => createGateway({ env, idleTimeoutMs: 0, approvalTimeoutMs }),
      /non-negative number of milliseconds/,
      `expected ${String(approvalTimeoutMs)} to be refused`,
    );
  }
  // Zero still means "wait indefinitely", which is a real (test-only) choice.
  const gateway = createGateway({ env, idleTimeoutMs: 0, approvalTimeoutMs: 0 });
  await gateway.stop();
});

test('a resolution a channel could not deliver is not filed as a human decision', async () => {
  const { gateway, transport, events } = await brokerHarness();

  const requested = nextEvent(gateway.bus, 'tool.approval-requested');
  const answer = transport.request(parkedCall('sess-undeliverable'));
  const request = await settles(requested, 'the approval request');

  // What a channel does when it has nobody to ask.
  assert.equal(
    gateway.resolveApproval({ requestId: request.requestId, answer: 'deny', reason: 'undeliverable' }),
    true,
  );
  assert.equal((await settles(answer, 'the parked call')).answer, 'deny');

  const resolved = events.find((event) => event.type === 'tool.approval-resolved');
  assert.equal(resolved?.reason, 'undeliverable');
  assert.equal(resolved?.actor, undefined);

  await gateway.stop();
});

test('a resolution never reaches a subscriber before the request it answers', async () => {
  // Both emissions walk the same subscriber list in order, so an async
  // subscriber ahead of a channel can hold the announcement while a
  // timeout fires behind it. A channel told about a resolution for a
  // request it has never heard of drops it, then renders the announcement
  // afterwards — buttons for a settled request that nothing retracts.
  const { gateway, transport } = await brokerHarness({ approvalTimeoutMs: 1 });

  const seen: string[] = [];
  let releaseAnnouncement: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseAnnouncement = resolve;
  });

  // Registered first, and slow on the announcement only — exactly the
  // shape that lets a resolution overtake it.
  gateway.bus.subscribe(async (event) => {
    if (event.type === 'tool.approval-requested') {
      await held;
    }
  });
  // A stand-in for the channel: order is all it records.
  gateway.bus.subscribe((event) => {
    if (event.type === 'tool.approval-requested' || event.type === 'tool.approval-resolved') {
      seen.push(event.type);
    }
  });

  const answer = transport.request(parkedCall('sess-order'));
  // Let the 1ms expiry fire while the announcement is still held.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, [], 'nothing reached the channel while the announcement was held');

  releaseAnnouncement?.();
  assert.equal((await settles(answer, 'the parked call')).answer, 'deny');
  await settles(gateway.stop(), 'the shutdown drain');

  assert.deepEqual(seen, ['tool.approval-requested', 'tool.approval-resolved']);
});

test('a daemon restart finishes the turns that were parked on a human', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  // Recovery resolves the runtime the way a dispatch would, which starts
  // from the agent's soul — so the roster has to hold the parked agent.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');

  // A session left exactly as a kill mid-approval leaves one: the response
  // durable, one call answered, the next checkpointed as parked, and the
  // one behind it never started.
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'parked-session',
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
      {
        id: 'm3',
        role: 'tool',
        name: 'demo.echo',
        content: '{}',
        createdAt: now,
        toolResult: { callId: 'c1', toolName: 'demo.echo', ok: true, output: null },
      },
      { id: 'm4', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c2', toolName: 'demo.echo', input: { text: 'two' } }] },
    ],
    metadata: {
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c2', toolName: 'demo.echo', input: { text: 'two' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  const recovered = nextEvent(gateway.bus, 'session.completed');
  await gateway.start();
  await settles(recovered, 'the recovered turn');
  await gateway.stop();

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('parked-session');
  after.close();

  // The checkpoint is spent, and the parked call finally has its result —
  // with the earlier one's untouched, never re-executed.
  assert.equal(session?.metadata?.[PENDING_APPROVAL_METADATA_KEY], undefined);
  assert.notEqual(session?.status, 'pending_approval');
  const results = (session?.messages ?? []).flatMap((message) => (message.toolResult ? [message.toolResult.callId] : []));
  assert.deepEqual(results, ['c1', 'c2'], 'every tool_use ended up with one tool_result');
});

test('the restart sweep resumes a parked turn in every agent store, not just one', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: demo\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nid: bea\nprovider: demo\n---\n\nYou are Bea.\n');

  // One parked turn per agent, which now means one per database. A sweep
  // that walked whichever store happened to be open would leave the other
  // agent's approval parked forever, with nobody watching — the failure the
  // fleet-wide session index exists to make impossible.
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  for (const [sessionId, agentId, name] of [['parked-ava', 'ava', 'Ava'], ['parked-bea', 'bea', 'Bea']] as const) {
    await seed.create({
      id: sessionId,
      agent: { id: agentId, name },
      status: 'pending_approval',
      messages: [
        { id: 'm1', role: 'user', content: 'go', createdAt: now },
        { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
      ],
      metadata: {
        [PENDING_APPROVAL_METADATA_KEY]: {
          call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
          remaining: [],
          parkedAt: now,
        },
      },
    });
  }
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  // Gated on the two completions themselves, never on a sleep: the point of
  // the test is which sessions the sweep reached, and a timer would pass by
  // luck on a fast runner and hang on a slow one.
  const completed = new Set<string>();
  const bothRecovered = new Promise<void>((resolve) => {
    gateway.bus.subscribe((event) => {
      if (event.type === 'session.completed') {
        completed.add(event.sessionId);
        if (completed.has('parked-ava') && completed.has('parked-bea')) {
          resolve();
        }
      }
    });
  });
  await gateway.start();
  await settles(bothRecovered, 'both recovered turns');
  await gateway.stop();

  const after = new ShardedSessionStore({ stateDir });
  for (const sessionId of ['parked-ava', 'parked-bea']) {
    const session = await after.get(sessionId);
    assert.equal(session?.metadata?.[PENDING_APPROVAL_METADATA_KEY], undefined, sessionId);
    assert.notEqual(session?.status, 'pending_approval', sessionId);
  }
  after.close();
});

test('a parked turn whose window ran out while the daemon was down is denied, not re-asked', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');

  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'stale-session',
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: {} }] },
    ],
    metadata: {
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: {} },
        remaining: [],
        // Parked an hour ago, against a one-minute window.
        parkedAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    },
  });
  seed.close();

  const asked: string[] = [];
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    stateDir,
    approvalTimeoutMs: 60_000,
    selection: { provider: 'demo' },
    approvals: () => ({
      async approve({ call }) {
        asked.push(call.toolName);
        return true;
      },
    }),
  });
  const recovered = nextEvent(gateway.bus, 'session.completed');
  await gateway.start();
  await settles(recovered, 'the recovered turn');
  await gateway.stop();

  // Nobody was asked: the request really did go unanswered for its whole
  // window, and downtime is not a reason to extend a security decision.
  assert.deepEqual(asked, []);

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('stale-session');
  after.close();
  const denied = (session?.messages ?? []).find((message) => message.toolResult?.callId === 'c1');
  assert.equal(denied?.toolResult?.ok, false);
  assert.match(denied?.toolResult?.error ?? '', /denied by approval policy/);
});

test('recovery runs on the session chain, so an inbound message cannot race it', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');

  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'raced-session',
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
    ],
    metadata: {
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  await gateway.start();
  // Channels are live before a sweep finishes, so this is the real race: a
  // message arriving for a session still being recovered. Unserialized,
  // resume() would close the parked call as interrupted while recovery
  // re-entered it, and both would save divergent transcripts.
  await gateway.dispatch({ sessionId: 'raced-session', agentId: 'ava', userMessage: 'still there?' });
  await gateway.stop();

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('raced-session');
  after.close();

  // One result for the parked call, and it is not the interrupted marker
  // resume() writes — recovery got there first, on the chain.
  const results = (session?.messages ?? []).filter((message) => message.toolResult?.callId === 'c1');
  assert.equal(results.length, 1, 'the call was answered exactly once');
  assert.doesNotMatch(results[0]?.toolResult?.error ?? '', /may not have run to completion/);
  assert.equal(session?.metadata?.[PENDING_APPROVAL_METADATA_KEY], undefined);
});

test('a soul that dropped a tool while the daemon was down is honoured on recovery', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  // The current soul allows only memory.remember — demo.echo is gone.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\ntools:\n  - memory.remember\n---\n\nYou are Ava.\n');

  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'tightened-session',
    // The definition frozen into the session still carries the old, wider
    // allowlist — which is what allowedToolsFor reads first.
    agent: { id: 'ava', name: 'Ava', tools: ['demo.echo', 'memory.remember'] },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
    ],
    metadata: {
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  const recovered = nextEvent(gateway.bus, 'session.completed');
  await gateway.start();
  await settles(recovered, 'the recovered turn');
  await gateway.stop();

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('tightened-session');
  after.close();

  // An allowlist is a permission boundary: a turn that outlived the change
  // must not execute what the change removed.
  const result = (session?.messages ?? []).find((message) => message.toolResult?.callId === 'c1');
  assert.equal(result?.toolResult?.ok, false);
  assert.match(result?.toolResult?.error ?? '', /not permitted for agent ava/);
});

test('one unanswered recovery does not hold up the other parked turns', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');

  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  for (const id of ['parked-a', 'parked-b']) {
    await seed.create({
      id,
      agent: { id: 'ava', name: 'Ava' },
      status: 'pending_approval',
      messages: [
        { id: 'm1', role: 'user', content: 'go', createdAt: now },
        { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: id } }] },
      ],
      metadata: {
        [PENDING_APPROVAL_METADATA_KEY]: {
          call: { id: 'c1', toolName: 'demo.echo', input: { text: id } },
          remaining: [],
          parkedAt: now,
        },
      },
    });
  }
  seed.close();

  // `parked-a` sorts first, and its approver never answers. Recovered in
  // sequence, `parked-b` would not even be asked until that resolves —
  // fifteen minutes by default, and never at all with a zero timeout.
  let releaseA: (() => void) | undefined;
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    stateDir,
    selection: { provider: 'demo' },
    approvals: () => ({
      async approve({ session }) {
        if (session.id === 'parked-a') {
          await new Promise<void>((resolve) => {
            releaseA = resolve;
          });
        }
        return true;
      },
    }),
  });

  const bDone = new Promise<void>((resolve) => {
    const off = gateway.bus.subscribe((event) => {
      if (event.type === 'session.completed' && event.sessionId === 'parked-b') {
        off();
        resolve();
      }
    });
  });

  await gateway.start();
  await settles(bDone, 'the second parked turn');

  // Let the first one go so the drain can finish; in the daemon proper,
  // stop() denies what the broker still holds.
  releaseA?.();
  await settles(gateway.stop(), 'the shutdown drain');
});

test('a re-asked request keeps the window it started with, not a fresh one', async () => {
  const { gateway, transport } = await brokerHarness({ approvalTimeoutMs: 60_000 });

  const requested = nextEvent(gateway.bus, 'tool.approval-requested');
  // Parked 59 seconds ago under a 60-second window: a second left, not
  // another minute. Without this a restart hands out a full window each
  // time, and a crash-looping daemon keeps a request alive indefinitely.
  const answer = transport.request({
    ...parkedCall('sess-carried'),
    parkedAt: new Date(Date.now() - 59_000).toISOString(),
  });
  const request = await settles(requested, 'the approval request');

  const remainingMs = Date.parse(request.expiresAt ?? '') - Date.now();
  assert.ok(remainingMs <= 1_500, `expected about a second left, got ${remainingMs}ms`);

  gateway.resolveApproval({ requestId: request.requestId, answer: 'deny' });
  assert.equal((await settles(answer, 'the parked call')).answer, 'deny');
  await gateway.stop();
});

test('a request whose window is already spent is denied without being announced', async () => {
  const { gateway, transport, events } = await brokerHarness({ approvalTimeoutMs: 60_000 });

  assert.equal(
    (await settles(
      transport.request({
        ...parkedCall('sess-spent'),
        parkedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      'the spent request',
    )).answer,
    'deny',
  );
  // Never asked: announcing a request that is already over would post
  // buttons nobody can usefully click.
  assert.equal(events.filter((event) => event.type === 'tool.approval-requested').length, 0);
  const resolved = events.find((event) => event.type === 'tool.approval-resolved');
  assert.equal(resolved?.reason, 'timeout');

  await gateway.stop();
});

test('a duplicate agent id stops the daemon starting, rather than picking a winner', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await writeSoul(home, 'a-first.md', '---\nname: First\nid: twin\n---\n\nYou are First.\n');
  await writeSoul(home, 'b-second.md', '---\nname: Second\nid: twin\n---\n\nYou are Second.\n');

  const gateway = createGateway({ env, idleTimeoutMs: 0, selection: { provider: 'demo' } });
  // Refusing to serve is the honest outcome: every id-keyed resource —
  // sessions, memory, credentials, Slack tokens — would otherwise belong
  // to whichever file sorted first.
  await assert.rejects(gateway.start(), /Two soul files declare the agent id twin/);
  await gateway.stop();
});

test('a soul claiming the built-in id is still skipped, not treated as a collision', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await writeSoul(home, 'impostor.md', '---\nname: Impostor\nid: stratus\n---\n\nYou are an impostor.\n');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');

  const warnings: string[] = [];
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'demo' },
    warn: (line) => warnings.push(line),
  });
  // Reserved is not duplicated. The built-in fallback is documented, so a
  // roster file must not be able to take it over — and must not be able to
  // take the daemon down by trying.
  await gateway.start();
  const ids = gateway.agents().map((agent) => agent.id).sort();
  assert.deepEqual(ids, ['ava', 'stratus']);
  assert.equal(gateway.agents().find((agent) => agent.id === 'stratus')?.name, 'Stratus');
  assert.ok(warnings.some((line) => line.includes('reserved')), JSON.stringify(warnings));
  await gateway.stop();
});

test('a hosted tool phase holds the watchdog, on a provider that never announces its calls', async () => {
  // The subscription path streams now, so the watchdog is armed for it —
  // and this provider dispatches tools *inside* generate, so no
  // provider.response ever announces them. The count the watchdog used to
  // read stays zero for the whole hosted phase; only the kernel's own tool
  // events say a tool is running. A turn whose tool legitimately outlives
  // the idle timeout has to survive, or a remote approval on this path
  // dies long before its own window does.
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'provider: anthropic',
    'tools:', '  - agent.delegate', 'delegates:', '  - bea', '---', '', 'You are Ava.', '',
  ].join('\n'));
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-test' } }),
  );

  const IDLE_MS = 300;

  // Bea is the slow phase: a delegated turn that takes longer than the
  // outer turn's idle timeout, the way a real tool waiting on a human or
  // a long command does.
  const fetchImpl = (async () => {
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 3));
    return openAiText('bea done');
  }) as typeof fetch;

  const queryFn = ((params: { options?: unknown }) => {
    const options = params.options as {
      mcpServers?: Record<string, {
        instance?: { _registeredTools?: Record<string, { handler: (a: unknown, b: unknown) => Promise<unknown> }> };
      }>;
    };
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
      // A delta first — this is what arms the timer on a streaming turn.
      yield {
        type: 'stream_event',
        session_id: 'sdk-1',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working' } },
      };
      const handler = options.mcpServers?.stratus?.instance?._registeredTools?.agent_delegate?.handler;
      if (!handler) {
        throw new Error('the delegate tool was not bridged');
      }
      await handler({ agent: 'bea', prompt: 'take your time' }, {});
      yield { type: 'result', subtype: 'success', is_error: false, result: 'all done', session_id: 'sdk-1' };
    })();
  }) as never;

  const gateway = createGateway({
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { OPENAI_API_KEY: 'sk-o' },
      fetch: fetchImpl,
      queryFn,
    },
    idleTimeoutMs: IDLE_MS,
    warn: () => {},
  });
  await gateway.start();

  const session = await gateway.dispatch({ sessionId: 'hosted-1', agentId: 'ava', userMessage: 'delegate it' });
  await gateway.stop();

  assert.equal(session.status, 'completed', `session failed: ${session.lastError ?? ''}`);
  assert.match(session.messages.at(-1)?.content ?? '', /all done/);
});

test('a stalled subscription fallback is cut loose by the gateway idle timeout', async () => {
  // A fallback the gateway does not recognise as streaming gets no
  // watchdog once a session switches to it, so a stall there would run to
  // the provider's own ten-minute timer instead of the idle timeout the
  // operator configured. Same two auth modes as a primary.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      openai: { type: 'api_key', value: 'sk-o' },
      anthropic: { type: 'oauth_token', value: 'sk-ant-oat' },
    }),
  );
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'openai', model: 'model-a', fallbackProvider: 'anthropic', fallbackModel: 'claude-opus-5' }),
  );

  const IDLE_MS = 300;
  // The primary fails, so the turn switches to the subscription fallback.
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  // Which then yields one message and stops — a stall, not an error.
  const queryFn = ((params: { options?: unknown }) => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
    yield {
      type: 'stream_event',
      session_id: 'sdk-1',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'thinking' } },
    };
    // Silent until aborted, which is what a wedged query looks like — and
    // it honours the controller the provider hands it, so the watchdog's
    // abort actually ends this generator rather than leaving it resident.
    const signal = (params.options as { abortController?: AbortController }).abortController?.signal;
    await new Promise<void>((resolve) => {
      if (!signal || signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })()) as never;

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, fetch: fetchImpl, queryFn },
    idleTimeoutMs: IDLE_MS,
    warn: () => {},
  });
  await gateway.start();

  // The gate needs a way to lose, and losing has to end the turn as well
  // as report it: unrecognised, the stall waits on the provider's own
  // ten-minute timer, and a deadline that only rejected would leave the
  // dispatch resident and hang the shutdown drain instead of failing.
  const rescue = new AbortController();
  const timer = setTimeout(() => rescue.abort(), 10_000);
  const dispatched = gateway.dispatch({
    sessionId: 'stall-1',
    agentId: 'ava',
    userMessage: 'hello',
    signal: rescue.signal,
  }).then((session) => session.lastError ?? 'completed', (error: unknown) => String(error));

  try {
    const outcome = await dispatched;
    assert.ok(
      !rescue.signal.aborted,
      'the stalled subscription fallback was never cut loose — the gateway watchdog did not arm for it',
    );
    assert.match(outcome, /no activity/);
  } finally {
    clearTimeout(timer);
    await gateway.stop();
  }
});

test('a subscription turn thinking past the idle timeout after a tool is not aborted', async () => {
  // The incident: Slack agents on a subscription failed with "Run aborted:
  // no activity for 120000ms" after every tool they called had completed.
  // The watchdog re-arms once the tool settles, and on current models a
  // long think streams no thinking text — the SDK reports it as
  // `thinking_tokens` instead, which used to stop at the provider's own
  // idle timer and never reach the bus.
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'provider: anthropic',
    'tools:', '  - demo.echo', '---', '', 'You are Ava.', '',
  ].join('\n'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat' } }),
  );

  // Ten reports, each well inside the window and together twice its length:
  // a healthy think the watchdog has to hear to leave alone.
  const IDLE_MS = 500;
  const REPORTS = 10;
  const queryFn = ((params: { options?: unknown }) => {
    const options = params.options as {
      abortController?: AbortController;
      mcpServers?: Record<string, {
        instance?: { _registeredTools?: Record<string, { handler: (a: unknown, b: unknown) => Promise<unknown> }> };
      }>;
    };
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
      const handler = options.mcpServers?.stratus?.instance?._registeredTools?.demo_echo?.handler;
      if (!handler) {
        throw new Error('the tool was not bridged');
      }
      await handler({ text: 'hi' }, {});
      for (let report = 0; report < REPORTS; report += 1) {
        await new Promise((resolve) => setTimeout(resolve, (IDLE_MS * 2) / REPORTS));
        // A real query stops when its controller fires; without this the
        // abort would be invisible here and the test would pass either way.
        if (options.abortController?.signal.aborted) {
          throw new Error('aborted');
        }
        yield { type: 'system', subtype: 'thinking_tokens', session_id: 'sdk-1' };
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'all done', session_id: 'sdk-1' };
    })();
  }) as never;

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, queryFn },
    idleTimeoutMs: IDLE_MS,
    approvals: { approve: async () => true },
    warn: () => {},
  });
  await gateway.start();

  try {
    const session = await gateway.dispatch({ sessionId: 'thinking-1', agentId: 'ava', userMessage: 'echo, then think' });
    assert.equal(session.status, 'completed', `session failed: ${session.lastError ?? ''}`);
    assert.match(session.messages.at(-1)?.content ?? '', /all done/);
  } finally {
    await gateway.stop();
  }
});

test('a slow approval holds the watchdog even when the policy emits nothing', async () => {
  // tool.approval-requested is the broker's event, so it exists only for
  // the remote path. A policy handed straight to the gateway emits
  // nothing, and tool.called comes only after the answer — so on a
  // streaming provider that hosts its own loop, a slow policy was
  // indistinguishable from a stalled turn. The same bug this watchdog work
  // exists to stop, arriving through a different door.
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'provider: anthropic',
    'tools:', '  - demo.echo', '---', '', 'You are Ava.', '',
  ].join('\n'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat' } }),
  );

  const IDLE_MS = 300;
  const queryFn = ((params: { options?: unknown }) => {
    const options = params.options as {
      mcpServers?: Record<string, {
        instance?: { _registeredTools?: Record<string, { handler: (a: unknown, b: unknown) => Promise<unknown> }> };
      }>;
    };
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
      yield {
        type: 'stream_event',
        session_id: 'sdk-1',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checking' } },
      };
      const handler = options.mcpServers?.stratus?.instance?._registeredTools?.demo_echo?.handler;
      if (!handler) {
        throw new Error('the tool was not bridged');
      }
      await handler({ text: 'hi' }, {});
      yield { type: 'result', subtype: 'success', is_error: false, result: 'all done', session_id: 'sdk-1' };
    })();
  }) as never;

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, queryFn },
    idleTimeoutMs: IDLE_MS,
    // A direct policy, not the factory: no transport, no events, and it
    // deliberates for longer than the idle timeout — which a policy
    // consulting anything outside the process legitimately might.
    approvals: {
      async approve() {
        await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 3));
        return true;
      },
    },
    warn: () => {},
  });
  await gateway.start();

  const session = await gateway.dispatch({ sessionId: 'slow-policy-1', agentId: 'ava', userMessage: 'echo please' });
  await gateway.stop();

  assert.equal(session.status, 'completed', `session failed: ${session.lastError ?? ''}`);
  assert.match(session.messages.at(-1)?.content ?? '', /all done/);
});

test('a policy that throws does not leave the next turn without a watchdog', async () => {
  // A throwing policy settles nothing — the runner propagates without
  // emitting tool.denied or tool.completed — so the phase it opened stays
  // open. On a *non-streaming* turn nothing else cleans it up either:
  // withWatchdog returns before its cleanup exists. The bill then lands on
  // a later streaming turn for the same session, which starts with its
  // watchdog already suppressed. Two turns, two runtimes, and the failure
  // is on neither the turn nor the path that caused it.
  const home = await newHome();
  const soul = path.join(home, '.stratus', 'agents', 'ava.md');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\ntools:\n  - demo.echo\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      openai: { type: 'api_key', value: 'sk-o' },
      anthropic: { type: 'oauth_token', value: 'sk-ant-oat' },
    }),
  );

  const IDLE_MS = 300;
  const fetchImpl = (async () => openAiToolCall('demo_echo', { text: 'hi' })) as typeof fetch;
  const queryFn = ((params: { options?: unknown }) => {
    const signal = (params.options as { abortController?: AbortController }).abortController?.signal;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
      yield {
        type: 'stream_event',
        session_id: 'sdk-1',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working' } },
      };
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    })();
  }) as never;

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, fetch: fetchImpl, queryFn },
    idleTimeoutMs: IDLE_MS,
    approvals: {
      async approve() {
        throw new Error('the policy could not decide');
      },
    },
    warn: () => {},
  });
  await gateway.start();

  // Turn one, non-streaming: the policy throws while a phase is open.
  await gateway.dispatch({ sessionId: 'leak-1', agentId: 'ava', userMessage: 'first' })
    .catch(() => undefined);

  // The same agent switches to the subscription runtime, which streams —
  // the gateway re-reads the soul per dispatch, so this takes effect on
  // the next turn of the same session.
  await writeFile(soul, '---\nname: Ava\nprovider: anthropic\ntools:\n  - demo.echo\n---\n\nYou are Ava.\n');

  const rescue = new AbortController();
  const timer = setTimeout(() => rescue.abort(), 10_000);
  const second = gateway.dispatch({ sessionId: 'leak-1', agentId: 'ava', userMessage: 'second', signal: rescue.signal })
    .then((session) => session.lastError ?? 'completed', (error: unknown) => String(error));

  try {
    const outcome = await second;
    assert.ok(
      !rescue.signal.aborted,
      'the next turn ran without a watchdog — the phase opened by the throwing policy was never settled',
    );
    assert.match(outcome, /no activity/);
  } finally {
    clearTimeout(timer);
    await gateway.stop();
  }
});

test('a provider retrying its own attempt keeps its watchdog', async () => {
  // A failed resume discards its partial output and replays into a fresh
  // SDK session — same provider, same turn. Reading that reset as the
  // fallback switch would disarm the watchdog for the rest of a turn that
  // never changed provider, and a stall in the replay would then wait on
  // the SDK's own ten-minute timer.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat' } }),
  );

  const IDLE_MS = 300;
  let attempt = 0;
  const queryFn = ((params: { options?: unknown }) => {
    const options = params.options as { resume?: string; abortController?: AbortController };
    attempt += 1;
    const thisAttempt = attempt;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
      yield {
        type: 'stream_event',
        session_id: 'sdk-1',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      };
      if (options.resume) {
        // The stored session is gone: this is what triggers the replay.
        throw new Error(`No conversation found with session ID: ${options.resume}`);
      }
      if (thisAttempt > 1) {
        // The replay stalls. Its watchdog has to still be armed.
        const signal = options.abortController?.signal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'first', session_id: 'sdk-1' };
    })();
  }) as never;

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, queryFn },
    idleTimeoutMs: IDLE_MS,
    warn: () => {},
  });
  await gateway.start();

  // Turn one records the SDK session id, so turn two resumes — and fails.
  await gateway.dispatch({ sessionId: 'retry-1', agentId: 'ava', userMessage: 'first' });

  const rescue = new AbortController();
  const timer = setTimeout(() => rescue.abort(), 10_000);
  const second = gateway.dispatch({ sessionId: 'retry-1', agentId: 'ava', userMessage: 'second', signal: rescue.signal })
    .then((session) => session.lastError ?? 'completed', (error: unknown) => String(error));

  try {
    const outcome = await second;
    assert.ok(
      !rescue.signal.aborted,
      'the replayed attempt ran without a watchdog — its reset was read as a fallback switch',
    );
    assert.match(outcome, /no activity/);
  } finally {
    clearTimeout(timer);
    await gateway.stop();
  }
});

test('an approved tool on a turn with no watchdog leaves nothing behind', async () => {
  // The sibling of the throwing-policy case, and the one that made the
  // old shape untenable: on a turn with no armed watchdog there is no
  // event observer, so nothing settled what the approval wrapper opened —
  // not even a perfectly ordinary approved call. The entry then suppressed
  // the watchdog for the next turn on that session.
  const home = await newHome();
  const soul = path.join(home, '.stratus', 'agents', 'ava.md');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\ntools:\n  - demo.echo\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      openai: { type: 'api_key', value: 'sk-o' },
      anthropic: { type: 'oauth_token', value: 'sk-ant-oat' },
    }),
  );

  const IDLE_MS = 300;
  let openAiCalls = 0;
  const fetchImpl = (async () => {
    openAiCalls += 1;
    return openAiCalls === 1 ? openAiToolCall('demo_echo', { text: 'hi' }) : openAiText('first done');
  }) as typeof fetch;

  const queryFn = ((params: { options?: unknown }) => {
    const signal = (params.options as { abortController?: AbortController }).abortController?.signal;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
      yield {
        type: 'stream_event',
        session_id: 'sdk-1',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working' } },
      };
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    })();
  }) as never;

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, fetch: fetchImpl, queryFn },
    idleTimeoutMs: IDLE_MS,
    // Approves normally. Nothing exotic — that is the point.
    approvals: { async approve() { return true; } },
    warn: () => {},
  });
  await gateway.start();

  // Turn one, non-streaming: withWatchdog returns before installing an
  // observer, so no tool event is ever seen for this call.
  const first = await gateway.dispatch({ sessionId: 'approved-1', agentId: 'ava', userMessage: 'first' });
  assert.equal(first.status, 'completed', `first turn failed: ${first.lastError ?? ''}`);

  // The same agent moves to the subscription runtime, which streams.
  await writeFile(soul, '---\nname: Ava\nprovider: anthropic\ntools:\n  - demo.echo\n---\n\nYou are Ava.\n');

  const rescue = new AbortController();
  const timer = setTimeout(() => rescue.abort(), 10_000);
  const second = gateway.dispatch({ sessionId: 'approved-1', agentId: 'ava', userMessage: 'second', signal: rescue.signal })
    .then((session) => session.lastError ?? 'completed', (error: unknown) => String(error));

  try {
    const outcome = await second;
    assert.ok(
      !rescue.signal.aborted,
      'the next turn ran without a watchdog — an ordinary approved call was never settled',
    );
    assert.match(outcome, /no activity/);
  } finally {
    clearTimeout(timer);
    await gateway.stop();
  }
});

/**
 * Resolves when `predicate` first sees a matching event, and rejects if
 * the gateway stops without one.
 *
 * A gate on the event itself rather than a sleep, because both sweeps in
 * `start()` are deliberately not awaited — the daemon must finish booting
 * with a slow approver outstanding — so there is nothing to await but the
 * outcome. The losing path has to reject rather than simply never resolve,
 * or a regression hangs the suite instead of failing the assertion.
 */
const eventGate = (
  gateway: { bus: { subscribe: (listener: (event: StratusEvent) => void) => () => void } },
  predicate: (event: StratusEvent) => boolean,
): { seen: Promise<StratusEvent>; give_up: (reason: string) => void } => {
  let settle: (event: StratusEvent) => void = () => {};
  let give_up: (reason: string) => void = () => {};
  const seen = new Promise<StratusEvent>((resolve, reject) => {
    settle = resolve;
    give_up = (reason: string) => reject(new Error(reason));
  });
  const unsubscribe = gateway.bus.subscribe((event) => {
    if (predicate(event)) {
      settle(event);
      unsubscribe();
    }
  });
  return { seen, give_up };
};

test('a turn the last stratusd left running is failed, with a reason that says so', async () => {
  // A crash mid-turn saves nothing: the session keeps the `running` it was
  // given when the turn started. Nothing picks that up — the parked sweep
  // only looks at `pending_approval`, and a hosted tool call is
  // deliberately never checkpointed — so without this the record claims
  // that turn is still running for as long as the session exists.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'abandoned-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'do the thing', createdAt: new Date().toISOString() }],
  });
  before.close();

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('unused')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const failed = eventGate(
    gateway,
    (event) => event.type === 'session.failed' && event.sessionId === 'abandoned-1',
  );
  await gateway.start();
  // stop() drains what start() left running, so a sweep that never ran
  // loses here instead of hanging the suite.
  await gateway.stop().then(() => failed.give_up('the abandoned turn was never failed'));

  const event = await failed.seen;
  assert.equal(event.type === 'session.failed' ? event.error : '', ABANDONED_TURN_ERROR);

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('abandoned-1');
  after.close();
  assert.equal(session?.status, 'failed');
  assert.equal(session?.lastError, ABANDONED_TURN_ERROR);
});

test('a parked turn is left to the approval sweep, not failed as abandoned', async () => {
  // The two sweeps must not both claim a session. A parked turn is the one
  // state a restart CAN pick up, and failing it here would throw away the
  // checkpoint that makes that possible.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'parked-not-abandoned-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [{ id: 'u1', role: 'user', content: 'gated work', createdAt: new Date().toISOString() }],
  });
  before.close();

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('unused')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  await gateway.start();
  await gateway.stop();

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('parked-not-abandoned-1');
  after.close();
  assert.notEqual(session?.lastError, ABANDONED_TURN_ERROR);
});

test('a message that beats the sweep keeps its turn, and the stale failure with it', async () => {
  // The list is read before the channels come up and applied after, so an
  // inbound message can land in between. Single-flight is what makes that
  // safe, and this is the interleaving it has to survive: the channel
  // dispatches from start(), which queues on the session chain ahead of
  // the sweep.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'raced-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'the turn that died', createdAt: new Date().toISOString() }],
  });
  before.close();

  let resumed = '';
  const adapter: GatewayChannelAdapter = {
    name: 'fake',
    async start(gw) {
      const session = await gw.dispatch({ sessionId: 'raced-1', agentId: 'ava', userMessage: 'try again' });
      resumed = session.messages.at(-1)?.content ?? '';
    },
    async stop() {},
  };

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('answered on the retry')) as typeof fetch,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    stateDir,
    channels: [adapter],
    warn: () => {},
  });
  await gateway.start();
  await gateway.stop();

  assert.match(resumed, /answered on the retry/);

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('raced-1');
  after.close();
  assert.equal(session?.status, 'completed', 'the live turn owns the session, not the sweep');
  assert.equal(session?.lastError, undefined);
});

// ---- control-API seams ----------------------------------------------------

test('a turn id names the turn that is actually running, not the one that queued', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  // Observed from inside the provider call, which runs within the turn: what
  // the gateway reports there is exactly what an event stamped at that moment
  // would carry.
  const seen: Array<{ message: string; turnId: string | undefined }> = [];
  let gateway: ReturnType<typeof createGateway> | undefined;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const lastUser = [...body.messages].reverse().find((message) => message.role === 'user');
    seen.push({ message: lastUser?.content ?? '', turnId: gateway?.activeTurnId('s-1') });
    return openAiText('ok');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  // Both queued before either is awaited: single-flight runs them in order,
  // and the second must not claim the stream while the first is still going.
  const first = gateway.dispatch({ sessionId: 's-1', agentId: 'ava', userMessage: 'first', turnId: 'turn-a' });
  const second = gateway.dispatch({ sessionId: 's-1', agentId: 'ava', userMessage: 'second', turnId: 'turn-b' });
  await settles(Promise.all([first, second]), 'both turns');

  assert.deepEqual(seen, [
    { message: 'first', turnId: 'turn-a' },
    { message: 'second', turnId: 'turn-b' },
  ]);
  // Cleared once the turn is over: a later event for this session belongs to
  // no turn, and saying otherwise would attribute it to whoever ran last.
  assert.equal(gateway.activeTurnId('s-1'), undefined);

  // A caller that named no turn leaves nothing behind either.
  await gateway.dispatch({ sessionId: 's-2', agentId: 'ava', userMessage: 'anonymous' });
  assert.equal(gateway.activeTurnId('s-2'), undefined);

  await gateway.stop();
});

test('pending approvals are listable, and the listing agrees with the announcement', async () => {
  const { gateway, transport } = await brokerHarness();

  // Nothing parked yet: a surface that connects to an idle daemon sees an
  // empty list, not a missing method.
  assert.deepEqual(gateway.pendingApprovals(), []);

  const requested = nextEvent(gateway.bus, 'tool.approval-requested');
  const answer = transport.request(parkedCall('sess-list'));
  const request = await settles(requested, 'the approval request');

  const parked = gateway.pendingApprovals();
  assert.equal(parked.length, 1);
  const only = parked[0];
  assert.equal(only?.requestId, request.requestId);
  assert.equal(only?.sessionId, 'sess-list');
  assert.equal(only?.agentId, 'ava');
  assert.equal(only?.call.toolName, 'shell.run');
  assert.equal(only?.risk, 'gated');
  assert.equal(only?.metadata?.slackChannel, 'C1');
  // The deadline is computed once and shared. A listing that disagreed with
  // the announcing event about when a request expires would be worse than a
  // listing that said nothing at all.
  assert.equal(only?.expiresAt, request.expiresAt);
  assert.ok(only?.parkedAt && Date.parse(only.parkedAt) > 0);

  assert.equal(gateway.resolveApproval({ requestId: request.requestId, answer: 'once' }), true);
  assert.equal((await settles(answer, 'the parked call')).answer, 'once');

  // Settled requests leave the list, so a panel rendered from it retracts
  // buttons instead of showing a decision that was already made.
  assert.deepEqual(gateway.pendingApprovals(), []);

  await gateway.stop();
});

test('reloading the roster picks up a new soul and forgets a deleted one', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  assert.deepEqual(gateway.agents().map((agent) => agent.id).sort(), ['ava', 'stratus']);

  await writeSoul(home, 'bea.md', '---\nname: Bea\nid: bea\n---\n\nYou are Bea.\n');
  await rm(path.join(home, '.stratus', 'agents', 'ava.md'));

  const roster = await gateway.reloadRoster();

  assert.deepEqual(roster.map((agent) => agent.id).sort(), ['bea', 'stratus']);
  assert.deepEqual(gateway.agents().map((agent) => agent.id).sort(), ['bea', 'stratus']);

  // Forgotten means undispatchable. Re-registering the survivors over a map
  // nothing deletes from would leave Ava addressable — by id, and from every
  // channel — for the rest of this daemon's life.
  await assert.rejects(
    gateway.dispatch({ sessionId: 'gone-1', agentId: 'ava', userMessage: 'still there?' }),
    /Agent not found: ava/,
  );

  await gateway.stop();
});

test('per-agent activity counts a parked turn as live, and listings can be bounded', async () => {
  const home = await newHome();
  const store = new ShardedSessionStore({ stateDir: path.join(home, 'state') });
  const session = (id: string, agentId: string, status: 'completed' | 'pending_approval') => ({
    id,
    agent: { id: agentId, name: agentId },
    status,
    messages: [],
  });

  await store.create(session('a-1', 'ava', 'completed'));
  await store.create(session('a-2', 'ava', 'pending_approval'));
  await store.create(session('b-1', 'bea', 'completed'));

  const activity = store.lastActivityByAgent();
  // A turn parked on a human has not saved since it parked, so a
  // last-activity timestamp alone would read it as idle — which is exactly
  // when someone wants to see the agent lit.
  assert.equal(activity.ava?.activeSessions, 1);
  assert.equal(activity.bea?.activeSessions, 0);
  assert.ok(activity.ava?.lastActiveAt && Date.parse(activity.ava.lastActiveAt) > 0);
  // A timestamp and a count, never a verdict: what counts as "recent" is the
  // caller's decision, so nothing here is compared against a window.
  assert.equal(activity.nobody, undefined);

  assert.equal(store.list().length, 3);
  assert.equal(store.list(undefined, 2).length, 2);
  assert.equal(store.list('ava').length, 2);
  assert.equal(store.list('ava', 1).length, 1);
  // The table grows for the life of an install; an unbounded default is what
  // the limit exists to opt out of, not a value to be clamped silently.
  assert.equal(store.list(undefined, 0).length, 0);
  store.close();
});

test('session counts come from the database, not from listing every session', async () => {
  const home = await newHome();
  const store = new ShardedSessionStore({ stateDir: path.join(home, 'state') });
  for (const [id, status] of [
    ['a', 'completed'], ['b', 'completed'], ['c', 'running'], ['d', 'pending_approval'],
  ] as const) {
    await store.create({ id, agent: { id: 'ava', name: 'Ava' }, status, messages: [] });
  }

  assert.deepEqual(store.countByStatus(), { completed: 2, running: 1, pending_approval: 1 });
  // The point is that this does not deserialize a conversation body per row —
  // a health endpoint is polled, and the table grows for the life of an
  // install. An empty store answers with an empty map, not a zeroed one.
  store.close();

  const empty = new ShardedSessionStore({ stateDir: path.join(home, 'empty') });
  assert.deepEqual(empty.countByStatus(), {});
  empty.close();
});

test('a session\'s usage survives a restart and reads back as stored', async () => {
  const home = await newHome();
  const dbPath = path.join(home, 'state', 'sessions.db');
  const usage = [
    { turnId: 's1:turn:1', provider: 'anthropic', model: 'claude-opus-5', inputTokens: 40, cacheReadTokens: 900 },
    { turnId: 's1:turn:2', provider: 'openai', model: 'gpt-5.5', inputTokens: 12, outputTokens: 3 },
  ];

  const store = new SqliteSessionStore(dbPath);
  const session = await store.create({
    id: 's1',
    agent: { id: 'a', name: 'A' },
    status: 'running',
    messages: [],
  });
  session.usage = usage;
  session.status = 'completed';
  await store.save(session);
  store.close();

  // A second connection to the same file is the restart: nothing in this
  // process is carrying the records.
  const reopened = new SqliteSessionStore(dbPath);
  const restored = await reopened.get('s1');
  reopened.close();

  // Grouped as stored — two providers and two models still separable, not a
  // total that arrived pre-collapsed.
  assert.deepEqual(restored?.usage, usage);
});

test('a delegated sub-session parked when the daemon died is failed, not re-asked', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'juno.md', '---\nname: Juno\nprovider: demo\n---\n\nYou are Juno.\n');

  // Exactly what a kill leaves behind when an orchestrator's agent.delegate
  // call is awaiting a sub-session that is itself parked on a human: the
  // parent still `running` (it is inside its tool call), the child
  // checkpointed on the gated call — and the child carrying the delegation
  // metadata `agent.delegate` stamps on it.
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'orchestrator',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [
      { id: 'm1', role: 'user', content: 'have juno do it', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'd1', toolName: 'agent.delegate', input: { agent: 'juno', prompt: 'do it' } }] },
    ],
  });
  const childId = 'orchestrator:delegate:juno:1:1-abcdefgh';
  await seed.create({
    id: childId,
    agent: { id: 'juno', name: 'Juno' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'do it', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'side effect' } }] },
    ],
    metadata: {
      delegationDepth: 1,
      delegatedBy: 'ava',
      rootSessionId: 'orchestrator',
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'side effect' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  // The default policy approves everything, so a re-asked child would run
  // its call and complete — which is exactly the outcome this test exists
  // to rule out.
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  const events: StratusEvent[] = [];
  const failed = new Set<string>();
  const bothClosed = new Promise<void>((resolve) => {
    gateway.bus.subscribe((event) => {
      events.push(event);
      if (event.type === 'session.failed') {
        failed.add(event.sessionId);
        if (failed.has('orchestrator') && failed.has(childId)) {
          resolve();
        }
      }
    });
  });
  await gateway.start();
  try {
    await settles(bothClosed, 'both halves of the delegation being closed out');
  } finally {
    // Whatever the gate says: a gateway left running holds the process
    // open, and a hung suite reads as broken infrastructure, not a defect.
    await gateway.stop();
  }

  const after = new ShardedSessionStore({ stateDir });
  const parent = await after.get('orchestrator');
  const child = await after.get(childId);
  after.close();

  assert.equal(parent?.status, 'failed');
  assert.equal(parent?.lastError, ABANDONED_TURN_ERROR);
  // The child is closed the same way its parent is, with a reason of its
  // own — not asked again, not run, and no longer a checkpoint for a later
  // sweep to pick up.
  assert.equal(child?.status, 'failed');
  assert.equal(child?.lastError, ORPHANED_DELEGATION_ERROR);
  assert.equal(child?.metadata?.[PENDING_APPROVAL_METADATA_KEY], undefined);
  assert.equal(
    events.some((event) => event.type === 'tool.called' && event.sessionId === childId),
    false,
    'the orphaned call never executed',
  );
  assert.equal((child?.messages ?? []).some((message) => message.toolResult !== undefined), false);
});

test('a dispatch may not supply the metadata keys the daemon writes for itself', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');
  const gateway = createGateway({ env, idleTimeoutMs: 0, selection: { provider: 'demo' } });
  await gateway.start();
  try {
    // The one that matters most: a caller who can write `delegatedBy` onto
    // an ordinary session has the restart sweep fail its parked turn as an
    // orphan instead of recovering it. Refused at the door, naming the key.
    await assert.rejects(
      () => gateway.dispatch({
        sessionId: 'forged-1',
        agentId: 'ava',
        userMessage: 'hi',
        metadata: { delegatedBy: 'ava', channel: 'web' },
      }),
      /"delegatedBy" is reserved/,
    );
    assert.equal(await gateway.store.get('forged-1'), undefined, 'nothing was created');

    // Every key in the list is refused, not just the one this was written for.
    for (const key of RESERVED_SESSION_METADATA_KEYS) {
      await assert.rejects(
        () => gateway.dispatch({ sessionId: `forged-${key}`, agentId: 'ava', userMessage: 'hi', metadata: { [key]: true } }),
        new RegExp(`"${key}" is reserved`),
      );
    }

    // Ordinary caller metadata still rides along untouched.
    const session = await gateway.dispatch({
      sessionId: 'honest-1',
      agentId: 'ava',
      userMessage: 'hi',
      metadata: { channel: 'web', thread: 'T1' },
    });
    assert.equal(session.metadata?.channel, 'web');
    assert.equal(session.metadata?.thread, 'T1');
  } finally {
    await gateway.stop();
  }
});

test('a sub-session continued from outside stops being a delegation', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await writeSoul(home, 'juno.md', '---\nname: Juno\nprovider: demo\n---\n\nYou are Juno.\n');
  const stateDir = path.join(home, 'state');

  // A finished delegation, as agent.delegate leaves one — and as its
  // result reported the id to whoever might message it next.
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  const childId = 'orchestrator:delegate:juno:1:1-abcdefgh';
  await seed.create({
    id: childId,
    agent: { id: 'juno', name: 'Juno' },
    status: 'completed',
    messages: [
      { id: 'm1', role: 'user', content: 'do it', createdAt: now },
      { id: 'm2', role: 'assistant', content: 'done', createdAt: now },
    ],
    metadata: { delegationDepth: 1, delegatedBy: 'ava', rootSessionId: 'orchestrator', channel: 'web' },
  });
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  await gateway.start();
  try {
    const continued = await gateway.dispatch({ sessionId: childId, userMessage: 'and now?' });
    assert.equal(continued.status, 'completed');
    // The markers are gone and the caller's own metadata is untouched: a
    // later turn of this conversation that parks is an ordinary parked
    // turn, not an orphan for the next restart to fail.
    assert.equal(continued.metadata?.delegatedBy, undefined);
    assert.equal(continued.metadata?.rootSessionId, undefined);
    assert.equal(continued.metadata?.delegationDepth, undefined);
    assert.equal(continued.metadata?.channel, 'web');
  } finally {
    await gateway.stop();
  }
});

test('a message to the parent that lands before the sweep does not turn the orphan back into a live delegation', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'juno.md', '---\nname: Juno\nprovider: demo\n---\n\nYou are Juno.\n');

  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'orchestrator',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [
      { id: 'm1', role: 'user', content: 'have juno do it', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'd1', toolName: 'agent.delegate', input: { agent: 'juno', prompt: 'do it' } }] },
    ],
  });
  const childId = 'orchestrator:delegate:juno:1:1-abcdefgh';
  await seed.create({
    id: childId,
    agent: { id: 'juno', name: 'Juno' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'do it', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'side effect' } }] },
    ],
    metadata: {
      delegationDepth: 1,
      delegatedBy: 'ava',
      rootSessionId: 'orchestrator',
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'side effect' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  // A channel whose first act is a message to the parent, completed before
  // start() returns — which is before the parked sweep begins. The resume
  // reconciles the parent's dangling agent.delegate call as interrupted,
  // so read live afterwards the parent awaits nothing; the child's reply
  // still has no reader.
  const parentPoked: GatewayChannelAdapter = {
    name: 'poke',
    async start(gateway) {
      await gateway.dispatch({ sessionId: 'orchestrator', userMessage: 'still there?' });
    },
    async stop() {},
  };

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' }, channels: [parentPoked] });
  const events: StratusEvent[] = [];
  const childClosed = new Promise<void>((resolve) => {
    gateway.bus.subscribe((event) => {
      events.push(event);
      if ((event.type === 'session.failed' || event.type === 'session.completed') && event.sessionId === childId) {
        resolve();
      }
    });
  });
  await gateway.start();
  try {
    await settles(childClosed, 'the child being closed out');
  } finally {
    await gateway.stop();
  }

  const after = new ShardedSessionStore({ stateDir });
  const child = await after.get(childId);
  after.close();
  assert.equal(child?.status, 'failed');
  assert.equal(child?.lastError, ORPHANED_DELEGATION_ERROR);
  assert.equal(events.some((event) => event.type === 'tool.called' && event.sessionId === childId), false, 'the orphaned call never executed');
});

test('only the child the outstanding delegation names is an orphan; a sibling parked on its own is recovered', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'juno.md', '---\nname: Juno\nprovider: demo\n---\n\nYou are Juno.\n');

  // The parent is inside its SECOND delegation to Juno. Its first one
  // finished long ago, and that sub-session was continued from outside
  // under a version that kept its markers; it is now parked on a turn of
  // its own. Both children name this parent in their ids.
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'orchestrator',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [
      { id: 'm1', role: 'user', content: 'have juno look', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'd1', toolName: 'agent.delegate', input: { agent: 'juno', prompt: 'look at it' } }] },
      { id: 'm3', role: 'tool', name: 'agent.delegate', content: '{}', createdAt: now, toolResult: { callId: 'd1', toolName: 'agent.delegate', ok: true, output: { reply: 'looked' } } },
      { id: 'm4', role: 'assistant', content: 'now the second thing', createdAt: now },
      { id: 'm5', role: 'user', content: 'have juno do it', createdAt: now },
      { id: 'm6', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'd2', toolName: 'agent.delegate', input: { agent: 'juno', prompt: 'do it' } }] },
    ],
  });
  const parked = (id: string, firstMessage: string) => ({
    id,
    agent: { id: 'juno', name: 'Juno' },
    status: 'pending_approval' as const,
    messages: [
      { id: 'm1', role: 'user' as const, content: firstMessage, createdAt: now },
      { id: 'm2', role: 'assistant' as const, content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: id } }] },
    ],
    metadata: {
      delegationDepth: 1,
      delegatedBy: 'ava',
      rootSessionId: 'orchestrator',
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: id } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  const genuine = 'orchestrator:delegate:juno:1:2-bbbbbbbb';
  const continued = 'orchestrator:delegate:juno:1:1-aaaaaaaa';
  await seed.create(parked(genuine, 'do it'));
  await seed.create(parked(continued, 'look at it'));
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  const settledIds = new Set<string>();
  const bothSettled = new Promise<void>((resolve) => {
    gateway.bus.subscribe((event) => {
      if (event.type === 'session.failed' || event.type === 'session.completed') {
        settledIds.add(event.sessionId);
        if (settledIds.has(genuine) && settledIds.has(continued)) {
          resolve();
        }
      }
    });
  });
  await gateway.start();
  try {
    await settles(bothSettled, 'both children being settled');
  } finally {
    await gateway.stop();
  }

  const after = new ShardedSessionStore({ stateDir });
  const orphan = await after.get(genuine);
  const sibling = await after.get(continued);
  after.close();
  assert.equal(orphan?.status, 'failed');
  assert.equal(orphan?.lastError, ORPHANED_DELEGATION_ERROR);
  // The sibling's delegation was answered long ago; what it is parked on
  // is its own, and the restart owes it ordinary recovery.
  assert.equal(sibling?.status, 'completed');
  assert.notEqual(sibling?.lastError, ORPHANED_DELEGATION_ERROR);
});

test('a parked session in the sub-session shape is only an orphan when its parent awaits it', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  // A legacy caller could have minted an id containing the marker and
  // written the key, both accepted before the public door refused them.
  // What it could not write is the parent's transcript: the session the id
  // names as parent exists, but holds no agent.delegate call awaiting a
  // reply, so this is an ordinary parked turn and is recovered as one.
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'web:ava:case',
    agent: { id: 'ava', name: 'Ava' },
    status: 'completed',
    messages: [
      { id: 'm1', role: 'user', content: 'earlier', createdAt: now },
      { id: 'm2', role: 'assistant', content: 'sure', createdAt: now },
    ],
  });
  await seed.create({
    id: 'web:ava:case:delegate:notes',
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
    ],
    metadata: {
      delegatedBy: 'somebody',
      rootSessionId: 'web:ava:case',
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  const recovered = nextEvent(gateway.bus, 'session.completed');
  await gateway.start();
  try {
    await settles(recovered, 'the recovered turn');
  } finally {
    await gateway.stop();
  }
  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('web:ava:case:delegate:notes');
  after.close();
  assert.equal(session?.status, 'completed');
  assert.notEqual(session?.lastError, ORPHANED_DELEGATION_ERROR);
});

test('a parked session is only an orphan when both halves say it was delegated', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  // A row from before the public door refused the daemon's own keys: an
  // ordinary conversation whose caller wrote `delegatedBy` into its
  // metadata. Nothing minted its id, so it is not a sub-session, and the
  // restart owes it the recovery any parked turn gets.
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: 'web:ava:legacy-forged',
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
    ],
    metadata: {
      delegatedBy: 'somebody',
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  const recovered = nextEvent(gateway.bus, 'session.completed');
  await gateway.start();
  try {
    await settles(recovered, 'the recovered turn');
  } finally {
    await gateway.stop();
  }
  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('web:ava:legacy-forged');
  after.close();
  assert.equal(session?.status, 'completed');
  assert.notEqual(session?.lastError, ORPHANED_DELEGATION_ERROR);
});

test('a one-shot whose parked firing is recovered after a restart is retired when that firing finishes', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');

  // What a kill leaves behind when a one-shot's firing was parked on a
  // human: the row spent (its slot consumed before the dispatch), kept only
  // as the approval's scope, and the firing's session checkpointed.
  const firingId = 'schedule:once-1:2026-01-01T00:00:00.000Z';
  const schedules = new SqliteScheduleStore(fleetDbIn(stateDir));
  schedules.insert({
    id: 'once-1',
    agentId: 'ava',
    cadence: { kind: 'at', at: '2026-01-01T00:00:00.000Z' },
    prompt: 'do the thing',
    createdAt: '2025-12-31T00:00:00.000Z',
    lastFiredAt: '2026-01-01T00:00:00.100Z',
    lastSessionId: firingId,
  });
  schedules.close();
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  await seed.create({
    id: firingId,
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'do the thing', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
    ],
    metadata: {
      scheduled: true,
      scheduleId: 'once-1',
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, selection: { provider: 'demo' } });
  const recovered = nextEvent(gateway.bus, 'session.completed');
  await gateway.start();
  try {
    // The start sweep keeps the row while the firing is parked; the firing
    // is then recovered and finishes in this process — which is exactly the
    // process that has no firing promise to retire the row from.
    await settles(recovered, 'the recovered firing');
    // The retirement follows the runner's return, a step after the event
    // above; wait for the row, with a way to lose.
    const retired = new Promise<void>((resolve) => {
      const check = (): void => {
        if (gateway.schedules().length === 0) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
    await settles(retired, 'the spent one-shot being retired with its firing');
  } finally {
    await gateway.stop();
  }
});

test('a recovered firing retires only its own one-shot row, and does so even when the recovery fails', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const stateDir = path.join(home, 'state');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: demo\n---\n\nYou are Ava.\n');

  // Two spent one-shots, each the scope of a parked firing. The first
  // firing's checkpoint is at a turn past the budget, so its recovery fails
  // durably rather than completing; the second stays parked throughout.
  // And an ordinary parked session — a row from before the public door
  // refused the daemon's own keys — carries the second schedule's id in its
  // metadata, which must not let it retire a row that is not its own.
  const failingFiring = 'schedule:once-fail:2026-01-01T00:00:00.000Z';
  const parkedFiring = 'schedule:once-parked:2026-01-01T00:00:00.000Z';
  const schedules = new SqliteScheduleStore(fleetDbIn(stateDir));
  for (const [id, lastSessionId] of [['once-fail', failingFiring], ['once-parked', parkedFiring]] as const) {
    schedules.insert({
      id,
      agentId: 'ava',
      cadence: { kind: 'at', at: '2026-01-01T00:00:00.000Z' },
      prompt: 'do the thing',
      createdAt: '2025-12-31T00:00:00.000Z',
      lastFiredAt: '2026-01-01T00:00:00.100Z',
      lastSessionId,
    });
  }
  schedules.close();
  const seed = new ShardedSessionStore({ stateDir });
  const now = new Date().toISOString();
  const parked = (id: string, metadata: Record<string, unknown>, turn: number) => ({
    id,
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval' as const,
    messages: [
      { id: 'm1', role: 'user' as const, content: 'do the thing', createdAt: now },
      { id: 'm2', role: 'assistant' as const, content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: id } }] },
    ],
    metadata: {
      ...metadata,
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: id } },
        remaining: [],
        parkedAt: now,
        turn,
      },
    },
  });
  await seed.create(parked(failingFiring, { scheduled: true, scheduleId: 'once-fail' }, 1_000));
  await seed.create(parked(parkedFiring, { scheduled: true, scheduleId: 'once-parked' }, 1));
  await seed.create(parked('web:ava:legacy', { scheduleId: 'once-parked' }, 1));
  seed.close();

  // The second firing's re-asked approval is never answered — it parks on
  // the gateway's own transport, which stop() settles at the end.
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    stateDir,
    selection: { provider: 'demo' },
    maxTurns: 5,
    approvalTimeoutMs: 0,
    approvals: (transport) => ({
      approve: async ({ session, call, risk }) => (session.id === parkedFiring
        ? (await transport.request({ session, call, risk })).answer !== 'deny'
        : true),
    }),
  });
  const closed = new Set<string>();
  const bothClosed = new Promise<void>((resolve) => {
    gateway.bus.subscribe((event) => {
      if (event.type === 'session.failed' || event.type === 'session.completed') {
        closed.add(event.sessionId);
        if (closed.has(failingFiring) && closed.has('web:ava:legacy')) {
          resolve();
        }
      }
    });
  });
  await gateway.start();
  try {
    await settles(bothClosed, 'the failing firing and the legacy session being closed out');
    const retired = new Promise<void>((resolve) => {
      const check = (): void => {
        if (!gateway.schedules().some((record) => record.id === 'once-fail')) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
    await settles(retired, 'the failed firing\'s row being retired');
    // The failed firing retired its row; the legacy session, whatever its
    // metadata says, retired nothing.
    assert.deepEqual(gateway.schedules().map((record) => record.id), ['once-parked']);
    const stored = await gateway.store.get(failingFiring);
    assert.equal(stored?.status, 'failed');
  } finally {
    await gateway.stop();
  }
});

test('GATEWAY_ONLY_TOOL_NAMES is exactly what a gateway adds over a plain host', async () => {
  // `stratus run` reads this list to tell a daemon soul's `schedule.*`
  // apart from a name that does not exist, and the list lives in
  // `@stratusagent/agents` rather than here — the CLI reaches the gateway
  // only through `await import`, since `bin.ts` loads the CLI to print the
  // Node floor message and this module pulls in `node:sqlite` at import.
  //
  // So proximity cannot hold the two together, and this does. Splitting
  // the registry exactly means drift fails in both directions: a new
  // gateway tool left off the list turns up in `shared`, and a name
  // removed or renamed turns up missing from the registry.
  const home = await newHome();
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
  });
  await gateway.start();
  try {
    const registered = gateway.tools().map((tool) => tool.name);
    const shared = registered.filter((name) => !GATEWAY_ONLY_TOOL_NAMES.includes(name));

    // Everything the list claims really is registered here.
    for (const name of GATEWAY_ONLY_TOOL_NAMES) {
      assert.ok(registered.includes(name), `${name} is listed as gateway-only but not registered`);
    }
    // And everything else is a tool a plain host registers too, so nothing
    // gateway-only is missing from the list.
    assert.deepEqual(shared.sort(), [
      'demo.echo',
      FORGET_TOOL_NAME,
      PIN_TOOL_NAME,
      RECALL_TOOL_NAME,
      MEMORY_TOOL_NAME,
      SKILL_READ_TOOL_NAME,
    ].sort());
  } finally {
    await gateway.stop();
  }
});

test('a dispatch carrying images stores them on the turn it opens and on the turn it resumes', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const shot = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'shot.png' };
  const opened = await gateway.dispatch({ sessionId: 'images-1', userMessage: 'what is this?', images: [shot] });
  const resumed = await gateway.dispatch({ sessionId: 'images-1', userMessage: 'and this?', images: [{ ...shot, name: 'other.png' }] });
  await gateway.stop();

  assert.deepEqual(opened.messages[0]?.images, [shot]);
  const asked = resumed.messages.filter((message) => message.role === 'user');
  assert.deepEqual(asked.map((message) => message.images?.[0]?.name), ['shot.png', 'other.png']);
});

test('a shared memory.jsonl a pre-per-agent build left is folded in by start(), not only by the CLI', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    legacyMemoryFilePath(env),
    `${JSON.stringify({
      id: 'ava:memory:1',
      agentId: 'ava',
      content: 'likes jazz',
      createdAt: new Date().toISOString(),
    })}\n`,
  );

  // The documented host path — `createGateway()` then `start()` — with no
  // CLI in front of it to have run the drain. Shared memory is not part of
  // what `start()` refuses over, because it does not need to be: the drain
  // below is unconditional and runs before anything serves.
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  await gateway.stop();

  // The store the gateway serves reads per-agent files only, so memories
  // still sitting in the shared file are memories the agent has lost.
  const memory = createHomeMemoryStore(env);
  assert.deepEqual((await memory.list('ava')).entries.map((entry) => entry.content), ['likes jazz']);
  // Copied, not moved: a pre-per-agent daemon still serving keeps reading
  // its own file. Retiring it belongs to the exclusive bracket.
  await stat(legacyMemoryFilePath(env));
});

test('a repeated idempotency key never starts a second turn', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText(`reply ${calls}`);
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    // Delivered twice before the first has run: the repeat is that turn.
    const [first, repeat] = await Promise.all([
      gateway.dispatch({ sessionId: 'idem-1', agentId: 'ava', userMessage: 'hello', idempotencyKey: 'msg-1' }),
      gateway.dispatch({ sessionId: 'idem-1', agentId: 'ava', userMessage: 'hello', idempotencyKey: 'msg-1' }),
    ]);
    assert.equal(calls, 1);
    assert.equal(repeat, first);
    assert.equal(first.messages.find((message) => message.role === 'user')?.idempotencyKey, 'msg-1');

    // Delivered again once it has finished: the session as it stands, and
    // no provider call.
    const later = await gateway.dispatch({ sessionId: 'idem-1', agentId: 'ava', userMessage: 'hello', idempotencyKey: 'msg-1' });
    assert.equal(calls, 1);
    assert.equal(later.status, 'completed');
    assert.equal(later.messages.filter((message) => message.role === 'user').length, 1);

    // A new key is a new message.
    const next = await gateway.dispatch({ sessionId: 'idem-1', agentId: 'ava', userMessage: 'again', idempotencyKey: 'msg-2' });
    assert.equal(calls, 2);
    assert.equal(next.messages.filter((message) => message.role === 'user').length, 2);

    // Scoped to the session: the same key elsewhere is somebody else's.
    await gateway.dispatch({ sessionId: 'idem-2', agentId: 'ava', userMessage: 'hello', idempotencyKey: 'msg-1' });
    assert.equal(calls, 3);

    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'idem-1', agentId: 'ava', userMessage: 'x', idempotencyKey: '' }),
      /idempotency key is 1 to 256 characters/,
    );
  } finally {
    await gateway.stop();
  }
});

test('a keyed turn the last stratusd left running is continued from its transcript, once', async () => {
  // The caller was promised this message would be answered: its key is
  // durable with the message, so a crash mid-turn is picked up rather than
  // failed and left for a redelivery that, being a repeat, would run nothing.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-abandoned-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'do the thing', createdAt: new Date().toISOString(), idempotencyKey: 'msg-1' }],
  });
  before.close();

  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText('done after the restart');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const completed = eventGate(
    gateway,
    (event) => event.type === 'session.completed' && event.sessionId === 'keyed-abandoned-1',
  );
  await gateway.start();
  await gateway.stop().then(() => completed.give_up('the keyed turn was never continued'));
  await completed.seen;

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('keyed-abandoned-1');
  after.close();
  assert.equal(calls, 1);
  assert.equal(session?.status, 'completed');
  assert.equal(session?.messages.at(-1)?.content, 'done after the restart');
  const users = session?.messages.filter((message) => message.role === 'user') ?? [];
  assert.equal(users.length, 1);
  assert.equal(users[0]?.continuedAfterCrash, true);
});

test('a keyed turn that died again after being continued is failed, not continued forever', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-twice-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'the turn that takes the daemon down',
      createdAt: new Date().toISOString(),
      idempotencyKey: 'msg-1',
      continuedAfterCrash: true,
    }],
  });
  before.close();

  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText('unused');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const failed = eventGate(gateway, (event) => event.type === 'session.failed' && event.sessionId === 'keyed-twice-1');
  await gateway.start();
  await gateway.stop().then(() => failed.give_up('the twice-abandoned turn was never failed'));

  const event = await failed.seen;
  assert.equal(event.type === 'session.failed' ? event.error : '', ABANDONED_TURN_ERROR);
  assert.equal(calls, 0);
});

test('a keyed turn whose reply was saved before the crash is completed without asking again', async () => {
  // The response is durable before it is announced, and the save that marks
  // the turn completed is a separate one: a process dying between them left
  // the answer in the transcript. Asking the provider again would send the
  // person a second answer to one message.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const now = new Date().toISOString();
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-answered-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [
      { id: 'u1', role: 'user', content: 'do the thing', createdAt: now, idempotencyKey: 'msg-1' },
      { id: 'a1', role: 'assistant', content: 'already answered', createdAt: now },
    ],
  });
  before.close();

  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText('a second answer');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const completed = eventGate(gateway, (event) => event.type === 'session.completed' && event.sessionId === 'keyed-answered-1');
  await gateway.start();
  await gateway.stop().then(() => completed.give_up('the answered turn was never completed'));
  await completed.seen;

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('keyed-answered-1');
  after.close();
  assert.equal(calls, 0);
  assert.equal(session?.status, 'completed');
  assert.equal(session?.messages.at(-1)?.content, 'already answered');
});

test('a redelivery that beats the sweep continues the turn it repeats, and starts no other', async () => {
  // The channels are up before the sweep runs, so the redelivery of the
  // message whose turn died takes the session chain first. It must find the
  // unfinished item and finish it — not resume the session with the same
  // text again, and not resolve with a session nothing is running.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-raced-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'the turn that died', createdAt: new Date().toISOString(), idempotencyKey: 'msg-1' }],
  });
  before.close();

  let redelivered: { status: string; users: number; reply: string } | undefined;
  const adapter: GatewayChannelAdapter = {
    name: 'fake',
    async start(gw) {
      const session = await gw.dispatch({
        sessionId: 'keyed-raced-1',
        agentId: 'ava',
        userMessage: 'the turn that died',
        idempotencyKey: 'msg-1',
        turnId: 'turn-redelivered',
      });
      redelivered = {
        status: session.status,
        users: session.messages.filter((message) => message.role === 'user').length,
        reply: session.messages.at(-1)?.content ?? '',
      };
    },
    async stop() {},
  };

  let calls = 0;
  let turnDuringCall: string | undefined;
  let gatewayRef: { activeTurnId: (sessionId: string) => string | undefined } | undefined;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      // The continuation runs on the redelivery's behalf, so its events
      // are that caller's turn.
      turnDuringCall = gatewayRef?.activeTurnId('keyed-raced-1');
      return openAiText('finished on the redelivery');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, channels: [adapter], warn: () => {} });
  gatewayRef = gateway;
  await gateway.start();
  await gateway.stop();

  assert.deepEqual(redelivered, { status: 'completed', users: 1, reply: 'finished on the redelivery' });
  assert.equal(calls, 1);
  assert.equal(turnDuringCall, 'turn-redelivered');
});

test('a keyed turn on a harness is failed, not continued, since its prompt may already have run tools there', async () => {
  // The subscription path runs the whole tool loop inside one provider
  // call and keeps its own conversation. A crash mid-call can leave tools
  // run that the transcript never recorded; continuing would send the
  // prompt again and run them twice.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-test' } }),
  );
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-harness-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'push the branch', createdAt: new Date().toISOString(), idempotencyKey: 'msg-1' }],
  });
  before.close();

  let queried = 0;
  const queryFn = (() => {
    queried += 1;
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'pushed again', session_id: 'sdk-1' };
    })();
  }) as never;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, queryFn },
    idleTimeoutMs: 0,
    stateDir,
    warn: () => {},
  });
  const failed = eventGate(gateway, (event) => event.type === 'session.failed' && event.sessionId === 'keyed-harness-1');
  await gateway.start();
  await gateway.stop().then(() => failed.give_up('the harness turn was never settled'));

  const event = await failed.seen;
  assert.equal(event.type === 'session.failed' ? event.error : '', ABANDONED_TURN_ERROR);
  assert.equal(queried, 0);
});

test('a keyed turn that could have run on a harness is failed even when the config no longer names one', async () => {
  // The agent was on a Claude subscription when the turn was accepted and
  // has been moved to an API key since. What decides is the runtime the
  // dead turn could have reached, recorded with its message — not the one a
  // restart resolves now.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-was-harness-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'push the branch',
      createdAt: new Date().toISOString(),
      idempotencyKey: 'msg-1',
      hostedLoop: true,
    }],
  });
  before.close();

  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText('pushed again');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const failed = eventGate(gateway, (event) => event.type === 'session.failed' && event.sessionId === 'keyed-was-harness-1');
  await gateway.start();
  await gateway.stop().then(() => failed.give_up('the turn was never settled'));

  const event = await failed.seen;
  assert.equal(event.type === 'session.failed' ? event.error : '', ABANDONED_TURN_ERROR);
  assert.equal(calls, 0);
});

test('a keyed message records whether its turn could reach a harness', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-test' } }),
  );
  const queryFn = (() => (async function* () {
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sdk-1' };
  })()) as never;
  const gateway = createGateway({
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { OPENAI_API_KEY: 'sk-o' },
      fetch: (async () => openAiText('done')) as typeof fetch,
      queryFn,
    },
    idleTimeoutMs: 0,
    warn: () => {},
  });
  await gateway.start();
  try {
    const harness = await gateway.dispatch({ sessionId: 'hl-1', agentId: 'ava', userMessage: 'hi', idempotencyKey: 'k1' });
    assert.equal(harness.messages.find((message) => message.role === 'user')?.hostedLoop, true);
    const api = await gateway.dispatch({ sessionId: 'hl-2', agentId: 'bea', userMessage: 'hi', idempotencyKey: 'k1' });
    assert.equal(api.messages.find((message) => message.role === 'user')?.hostedLoop, undefined);
  } finally {
    await gateway.stop();
  }
});

test('a keyed turn whose agent is gone is failed, not left running for every later start', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-orphan-1',
    agent: { id: 'gone', name: 'Gone' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'hello', createdAt: new Date().toISOString(), idempotencyKey: 'msg-1' }],
  });
  before.close();

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('unused')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const failed = eventGate(gateway, (event) => event.type === 'session.failed' && event.sessionId === 'keyed-orphan-1');
  await gateway.start();
  await gateway.stop().then(() => failed.give_up('the orphaned keyed turn stayed running'));

  const event = await failed.seen;
  assert.equal(event.type === 'session.failed' ? event.error : '', ABANDONED_TURN_ERROR);
});

test('a different message that beats the sweep waits for the keyed turn it would have buried', async () => {
  // Resumed onto the unfinished turn, the new message would become the
  // session's newest, and the old key would read finished: its redelivery
  // would then run nothing although its turn never did.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-buried-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'first', createdAt: new Date().toISOString(), idempotencyKey: 'msg-1' }],
  });
  before.close();

  let final: Array<{ role: string; content: string; key?: string }> = [];
  const adapter: GatewayChannelAdapter = {
    name: 'fake',
    async start(gw) {
      const session = await gw.dispatch({ sessionId: 'keyed-buried-1', agentId: 'ava', userMessage: 'second', idempotencyKey: 'msg-2' });
      final = session.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.idempotencyKey !== undefined ? { key: message.idempotencyKey } : {}),
      }));
    },
    async stop() {},
  };

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      return openAiText(`answer to ${body.messages.at(-1)?.content ?? ''}`);
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, channels: [adapter], warn: () => {} });
  await gateway.start();
  await gateway.stop();

  assert.deepEqual(final, [
    { role: 'user', content: 'first', key: 'msg-1' },
    { role: 'assistant', content: 'answer to first' },
    { role: 'user', content: 'second', key: 'msg-2' },
    { role: 'assistant', content: 'answer to second' },
  ]);
});

test('a continued turn whose last response held a call before its text goes back to the provider', async () => {
  // A provider may put text after a tool call in one response. Cut off
  // before the call's result was recorded, that response is not an answer:
  // the model is owed the (interrupted) result and another turn.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');

  const now = new Date().toISOString();
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-call-then-text-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [
      { id: 'u1', role: 'user', content: 'do the thing', createdAt: now, idempotencyKey: 'msg-1' },
      { id: 'a1', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'call-1', toolName: 'demo.echo', input: {} }] },
      { id: 'a2', role: 'assistant', content: 'checking now', createdAt: now },
    ],
  });
  before.close();

  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText('it was interrupted; here is where things stand');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const completed = eventGate(gateway, (event) => event.type === 'session.completed' && event.sessionId === 'keyed-call-then-text-1');
  await gateway.start();
  await gateway.stop().then(() => completed.give_up('the turn was never completed'));
  await completed.seen;

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('keyed-call-then-text-1');
  after.close();
  assert.equal(calls, 1);
  assert.equal(session?.messages.at(-1)?.content, 'it was interrupted; here is where things stand');
  assert.ok(session?.messages.some((message) => message.role === 'tool' && message.toolResult?.callId === 'call-1' && message.toolResult.ok === false));
  // The interrupted result goes after the whole response, as a finished
  // turn writes it: between the call and its text, a provider replaying the
  // response's raw turn would send the text twice.
  assert.deepEqual(session?.messages.map((message) => message.id === 'a2' ? 'text' : message.role), [
    'user', 'assistant', 'text', 'tool', 'assistant',
  ]);
});

test('a keyed turn on a session switched for good to a stateless fallback is not marked as reaching a harness', async () => {
  // The primary is a Claude subscription, a harness; the fallback is an API.
  // Once the session has switched, the primary is never called again, so
  // this turn cannot reach the harness, and a crash in it can be continued.
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'openai',
  }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-test' } }),
  );
  const queryFn = (() => {
    throw new Error('the primary should not be called for a switched session');
  }) as never;
  const gateway = createGateway({
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { OPENAI_API_KEY: 'sk-o' },
      fetch: (async () => openAiText('from the fallback')) as typeof fetch,
      queryFn,
    },
    idleTimeoutMs: 0,
    warn: () => {},
  });
  await gateway.start();
  try {
    await gateway.store.create({
      id: 'switched-keyed-1',
      agent: { id: 'stratus', name: 'Stratus' },
      status: 'completed',
      messages: [
        { id: 'u1', role: 'user', content: 'earlier', createdAt: new Date().toISOString() },
        { id: 'a1', role: 'assistant', content: 'earlier reply', createdAt: new Date().toISOString() },
      ],
      metadata: { fallbackActive: true },
    });
    const switched = await gateway.dispatch({ sessionId: 'switched-keyed-1', userMessage: 'again', idempotencyKey: 'k1' });
    assert.equal(switched.messages.at(-1)?.content, 'from the fallback');
    assert.equal(switched.messages.findLast((message) => message.role === 'user')?.hostedLoop, undefined);

    // Not switched: the harness primary is the one that will answer.
    const fresh = await gateway.dispatch({ sessionId: 'fresh-keyed-1', userMessage: 'hi', idempotencyKey: 'k1' }).catch(() => undefined);
    const stored = await gateway.store.get('fresh-keyed-1');
    assert.equal(stored?.messages.find((message) => message.role === 'user')?.hostedLoop, true, String(fresh?.status));
  } finally {
    await gateway.stop();
  }
});

test('a keyed turn whose continuation could fall back to a harness is failed, not continued', async () => {
  // The primary is a stateless API, but the fallback added since is a
  // Claude subscription: a continuation whose primary failed would enter
  // that hosted loop, which the recovery policy refuses.
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'anthropic',
  }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-test' } }),
  );
  const stateDir = path.join(home, 'state');
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-fallback-harness-1',
    agent: { id: 'stratus', name: 'Stratus' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'hello', createdAt: new Date().toISOString(), idempotencyKey: 'msg-1' }],
  });
  before.close();

  let calls = 0;
  const gateway = createGateway({
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { OPENAI_API_KEY: 'sk-o' },
      fetch: (async () => {
        calls += 1;
        return openAiText('unused');
      }) as typeof fetch,
      queryFn: (() => {
        throw new Error('the harness must not be reached');
      }) as never,
    },
    idleTimeoutMs: 0,
    stateDir,
    warn: () => {},
  });
  const failed = eventGate(gateway, (event) => event.type === 'session.failed' && event.sessionId === 'keyed-fallback-harness-1');
  await gateway.start();
  await gateway.stop().then(() => failed.give_up('the turn was never settled'));

  const event = await failed.seen;
  assert.equal(event.type === 'session.failed' ? event.error : '', ABANDONED_TURN_ERROR);
  assert.equal(calls, 0);
});

test('a keyed turn parked on approval whose recovery cannot start is failed, not parked forever', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');
  const now = new Date().toISOString();
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-parked-orphan-1',
    agent: { id: 'gone', name: 'Gone' },
    status: 'pending_approval',
    messages: [
      { id: 'u1', role: 'user', content: 'gated work', createdAt: now, idempotencyKey: 'msg-1' },
      { id: 'a1', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
    ],
    metadata: {
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  before.close();

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('unused')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const failed = eventGate(gateway, (event) => event.type === 'session.failed' && event.sessionId === 'keyed-parked-orphan-1');
  await gateway.start();
  await gateway.stop().then(() => failed.give_up('the parked keyed turn stayed parked'));
  await failed.seen;

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('keyed-parked-orphan-1');
  after.close();
  assert.equal(session?.status, 'failed');
  assert.equal(session?.metadata?.[PENDING_APPROVAL_METADATA_KEY], undefined);
});

test('a saved answer is completed even after a second crash, and even on a harness', async () => {
  // The continuation died after saving the final response and before the
  // save marking it completed. Completing it calls no provider, so neither
  // the once-only rule nor the harness rule has anything to protect.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');
  const now = new Date().toISOString();
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-answered-twice-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [
      { id: 'u1', role: 'user', content: 'hello', createdAt: now, idempotencyKey: 'msg-1', continuedAfterCrash: true, hostedLoop: true },
      { id: 'a1', role: 'assistant', content: 'the saved answer', createdAt: now },
    ],
  });
  before.close();

  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText('a second answer');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const completed = eventGate(gateway, (event) => event.type === 'session.completed' && event.sessionId === 'keyed-answered-twice-1');
  await gateway.start();
  await gateway.stop().then(() => completed.give_up('the saved answer was never completed'));
  await completed.seen;

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('keyed-answered-twice-1');
  after.close();
  assert.equal(calls, 0);
  assert.equal(session?.status, 'completed');
  assert.equal(session?.messages.at(-1)?.content, 'the saved answer');
});

test('a saved answer is completed even when its agent is gone', async () => {
  // Completing it needs no current agent and no provider, so neither
  // missing is a reason to throw the finished reply away.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');
  const now = new Date().toISOString();
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-answered-orphan-1',
    agent: { id: 'gone', name: 'Gone' },
    status: 'running',
    messages: [
      { id: 'u1', role: 'user', content: 'hello', createdAt: now, idempotencyKey: 'msg-1' },
      { id: 'a1', role: 'assistant', content: 'the saved answer', createdAt: now },
    ],
  });
  before.close();

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('unused')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, warn: () => {} });
  const completed = eventGate(gateway, (event) => event.type === 'session.completed' && event.sessionId === 'keyed-answered-orphan-1');
  await gateway.start();
  await gateway.stop().then(() => completed.give_up('the saved answer was failed, not completed'));
  await completed.seen;

  const after = new ShardedSessionStore({ stateDir });
  const session = await after.get('keyed-answered-orphan-1');
  after.close();
  assert.equal(session?.status, 'completed');
  assert.equal(session?.messages.at(-1)?.content, 'the saved answer');
});

test('a continued turn spends the budget it was on, not a fresh one', async () => {
  // One tool turn already ran before the crash and maxTurns is 1, so what
  // the continuation owes the model is the wrap-up — not another turn that
  // could call a tool past the ceiling.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const stateDir = path.join(home, 'state');
  const now = new Date().toISOString();
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'keyed-budget-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [
      { id: 'u1', role: 'user', content: 'do the thing', createdAt: now, idempotencyKey: 'msg-1' },
      { id: 'a1', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'call-1', toolName: 'demo.echo', input: {} }] },
      {
        id: 't1',
        role: 'tool',
        name: 'demo.echo',
        content: '{}',
        createdAt: now,
        toolResult: { callId: 'call-1', toolName: 'demo.echo', ok: true, output: 'echoed', trust: 'agent' },
      },
    ],
  });
  before.close();

  const bodies: string[] = [];
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return openAiText('here is what I did');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, maxTurns: 1, warn: () => {} });
  const completed = eventGate(gateway, (event) => event.type === 'session.completed' && event.sessionId === 'keyed-budget-1');
  await gateway.start();
  await gateway.stop().then(() => completed.give_up('the turn was never completed'));
  await completed.seen;

  assert.equal(bodies.length, 1);
  assert.ok(bodies[0]?.includes('You have used every step this message allows'), 'the continuation was not the wrap-up');
});

test('two different session and key pairs never attach to each other\'s turn, however their strings are spelled', async () => {
  // Joined with a separator, ("x", "y\u0000z") and ("x\u0000y", "z") read
  // the same, and the second dispatch would resolve with the first's turn
  // without ever running its own.
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText(`reply ${calls}`);
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    const [first, second] = await Promise.all([
      gateway.dispatch({ sessionId: 'x', agentId: 'blair', userMessage: 'one', idempotencyKey: 'y\u0000z' }),
      gateway.dispatch({ sessionId: 'x\u0000y', agentId: 'blair', userMessage: 'two', idempotencyKey: 'z' }),
    ]);
    assert.equal(calls, 2);
    assert.equal(first.id, 'x');
    assert.equal(second.id, 'x\u0000y');
  } finally {
    await gateway.stop();
  }
});

test('a message accepted just before shutdown does not bury a keyed item its recovery skipped', async () => {
  // Accepted while the gateway was still serving, run once it is stopping:
  // recovery of the parked item ahead of it returns at the shutdown guard,
  // and resuming the session over it would make the old key read finished
  // with its turn never run.
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('unused')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  // Created after start, so the start-up sweep never saw it: the dispatch
  // below is the first thing to reach it.
  const now = new Date().toISOString();
  await gateway.store.create({
    id: 'keyed-parked-stopping-1',
    agent: { id: 'blair', name: 'Blair' },
    status: 'pending_approval',
    messages: [
      { id: 'u1', role: 'user', content: 'gated work', createdAt: now, idempotencyKey: 'msg-1' },
      { id: 'a1', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
    ],
    metadata: {
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });

  // dispatch() queues its work on the session chain synchronously, and that
  // work runs only on a later microtask; stop() sets the stopping flag
  // synchronously. So the work is certain to run with the gateway stopping.
  const turn = gateway.dispatch({ sessionId: 'keyed-parked-stopping-1', agentId: 'blair', userMessage: 'newer', idempotencyKey: 'msg-2' });
  const stopped = gateway.stop();
  await assert.rejects(turn, /stopping/);
  await stopped;

  const after = new ShardedSessionStore({ stateDir: path.join(home, '.stratus') });
  const session = await after.get('keyed-parked-stopping-1');
  after.close();
  assert.equal(session?.status, 'pending_approval');
  assert.deepEqual(session?.messages.filter((message) => message.role === 'user').map((message) => message.content), ['gated work']);
});

test('onRepeat says whether a dispatch attached to a live turn or repeated a finished one, and only then', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('reply')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    const repeats: string[] = [];
    const send = (label: string, key: string) =>
      gateway.dispatch({ sessionId: 'rep-1', agentId: 'blair', userMessage: label, idempotencyKey: key, onRepeat: (kind) => repeats.push(`${label}: ${kind}`) });

    // Live: the second attaches to the first while it is still queued.
    await Promise.all([send('first', 'k1'), send('live repeat', 'k1')]);
    // Finished: the turn is over and the repeat runs nothing, and its
    // reply is the caller's to read from the session.
    const finished = await send('finished repeat', 'k1');
    assert.equal(turnReplyFor(finished, 'k1'), 'reply');
    // A new key is a new message.
    await send('second', 'k2');
    assert.deepEqual(repeats, ['live repeat: live', 'finished repeat: finished']);
  } finally {
    await gateway.stop();
  }
});

test('onRepeat is not called for a repeat that continues a turn a crash left unfinished', async () => {
  // Nobody else is rendering that turn, so the caller that brought it back
  // should render it as its own.
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  const stateDir = path.join(home, 'state');
  const before = new ShardedSessionStore({ stateDir });
  await before.create({
    id: 'rep-crash-1',
    agent: { id: 'blair', name: 'Blair' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'hello', createdAt: new Date().toISOString(), idempotencyKey: 'msg-1' }],
  });
  before.close();

  let repeated = false;
  let status = '';
  const adapter: GatewayChannelAdapter = {
    name: 'fake',
    async start(gw) {
      const session = await gw.dispatch({
        sessionId: 'rep-crash-1',
        agentId: 'blair',
        userMessage: 'hello',
        idempotencyKey: 'msg-1',
        onRepeat: () => {
          repeated = true;
        },
      });
      status = session.status;
    },
    async stop() {},
  };
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('continued')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir, channels: [adapter], warn: () => {} });
  await gateway.start();
  await gateway.stop();
  assert.equal(status, 'completed');
  assert.equal(repeated, false);
});

test('a repeat naming another agent is refused, live or finished, and never handed the session', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('reply')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    const repeats: string[] = [];
    const first = gateway.dispatch({ sessionId: 'id-1', agentId: 'blair', userMessage: 'hello', idempotencyKey: 'k1' });
    // Live: the first is still queued when this arrives.
    const live = gateway.dispatch({
      sessionId: 'id-1',
      agentId: 'cora',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(kind),
    });
    await assert.rejects(live, /belongs to agent blair, not cora/);
    assert.equal((await first).status, 'completed');
    // Finished.
    await assert.rejects(
      gateway.dispatch({ sessionId: 'id-1', agentId: 'cora', userMessage: 'hello', idempotencyKey: 'k1', onRepeat: (kind) => repeats.push(kind) }),
      /belongs to agent blair, not cora/,
    );
    assert.deepEqual(repeats, []);
    // A third, from the right agent, still repeats the turn rather than
    // running it again.
    const again = await gateway.dispatch({ sessionId: 'id-1', agentId: 'blair', userMessage: 'hello', idempotencyKey: 'k1' });
    assert.equal(again.messages.filter((message) => message.role === 'user').length, 1);
  } finally {
    await gateway.stop();
  }
});

test('a repeat arriving just after a rollover is found in the archived transcript and runs nothing', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText('the answer');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'roll-1', agentId: 'blair', userMessage: 'hello', idempotencyKey: 'k1' });
    const { archivedAs } = await gateway.rolloverSession('roll-1');
    const before = calls;
    const repeats: string[] = [];
    const repeated = await gateway.dispatch({
      sessionId: 'roll-1',
      agentId: 'blair',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(kind),
    });
    assert.equal(calls, before);
    assert.deepEqual(repeats, ['finished']);
    assert.equal(repeated.id, archivedAs);
    assert.equal(turnReplyFor(repeated, 'k1'), 'the answer');
  } finally {
    await gateway.stop();
  }
});

test('a repeat naming the agent a live dispatch left unnamed attaches to it, and is refused for any other', async () => {
  const home = await newHome();
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('reply')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    const repeats: string[] = [];
    // The default agent's — the built-in one, here — with no agent named.
    const first = gateway.dispatch({ sessionId: 'unnamed-1', userMessage: 'hello', idempotencyKey: 'k1' });
    const named = gateway.dispatch({
      sessionId: 'unnamed-1',
      agentId: 'stratus',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(`stratus: ${kind}`),
    });
    const other = gateway.dispatch({
      sessionId: 'unnamed-1',
      agentId: 'cora',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(`cora: ${kind}`),
    });
    await assert.rejects(other, /belongs to agent stratus, not cora/);
    assert.equal((await named).agent.id, 'stratus');
    await first;
    assert.deepEqual(repeats, ['stratus: live']);
  } finally {
    await gateway.stop();
  }
});

test('a repeat attached to an unnamed live dispatch whose turn fails is still told it repeated, or refused', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })) as typeof fetch,
  };
  // Blair is the default, so the dispatch naming nobody runs on a provider
  // that fails it.
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {}, selection: { soul: path.join(home, '.stratus', 'agents', 'blair.md') } });
  await gateway.start();
  try {
    const repeats: string[] = [];
    const first = gateway.dispatch({ sessionId: 'unnamed-fail-1', userMessage: 'hello', idempotencyKey: 'k1' });
    const named = gateway.dispatch({
      sessionId: 'unnamed-fail-1',
      agentId: 'blair',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(`blair: ${kind}`),
    });
    const other = gateway.dispatch({
      sessionId: 'unnamed-fail-1',
      agentId: 'cora',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(`cora: ${kind}`),
    });
    await assert.rejects(first);
    await assert.rejects(named, (error: unknown) => !(error instanceof Error && /never cross agent identities/.test(error.message)));
    await assert.rejects(other, /belongs to agent blair, not cora/);
    assert.deepEqual(repeats, ['blair: live']);
  } finally {
    await gateway.stop();
  }
});

test('a refused claimant that registered a key first does not leave its owner\'s turn without a live entry', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      if (calls === 2) {
        started();
        await held;
      }
      return openAiText('reply');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    // The session is Blair's.
    await gateway.dispatch({ sessionId: 'claim-1', agentId: 'blair', userMessage: 'first', idempotencyKey: 'k0' });
    const repeats: string[] = [];
    // A claimant naming another agent gets to the new key first, and is refused.
    const wrong = gateway.dispatch({ sessionId: 'claim-1', agentId: 'cora', userMessage: 'hello', idempotencyKey: 'k1' });
    const owner = gateway.dispatch({ sessionId: 'claim-1', agentId: 'blair', userMessage: 'hello', idempotencyKey: 'k1' });
    await assert.rejects(wrong, /belongs to agent blair, not cora/);
    // While the owner's turn runs, its redelivery attaches to it.
    await running;
    const redelivered = gateway.dispatch({
      sessionId: 'claim-1',
      agentId: 'blair',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(kind),
    });
    release();
    await owner;
    await redelivered;
    assert.deepEqual(repeats, ['live']);
  } finally {
    release();
    await gateway.stop();
  }
});

test('a repeat naming nobody, of a claim naming the wrong agent, runs once that claim is refused', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('reply')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'unnamed-claim-1', agentId: 'blair', userMessage: 'first', idempotencyKey: 'k0' });
    const repeats: string[] = [];
    const wrong = gateway.dispatch({ sessionId: 'unnamed-claim-1', agentId: 'cora', userMessage: 'hello', idempotencyKey: 'k1' });
    const unnamed = gateway.dispatch({
      sessionId: 'unnamed-claim-1',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(kind),
    });
    await assert.rejects(wrong, /belongs to agent blair, not cora/);
    const session = await unnamed;
    assert.equal(session.agent.id, 'blair');
    assert.equal(session.status, 'completed');
    assert.deepEqual(session.messages.filter((message) => message.idempotencyKey === 'k1').length, 1);
    assert.deepEqual(repeats, []);
  } finally {
    await gateway.stop();
  }
});

test('a repeat naming nobody, of a claim that failed before writing anything, runs on its own', async () => {
  const home = await newHome();
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('reply')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    const repeats: string[] = [];
    // A new session, claimed for an agent the roster does not have: the
    // claim fails before its keyed message is ever written.
    const ghost = gateway.dispatch({ sessionId: 'unowned-1', agentId: 'ghost', userMessage: 'hello', idempotencyKey: 'k1' });
    const unnamed = gateway.dispatch({
      sessionId: 'unowned-1',
      userMessage: 'hello',
      idempotencyKey: 'k1',
      onRepeat: (kind) => repeats.push(kind),
    });
    await assert.rejects(ghost);
    const session = await unnamed;
    assert.equal(session.messages.filter((message) => message.idempotencyKey === 'k1').length, 1);
    assert.deepEqual(repeats, []);
  } finally {
    await gateway.stop();
  }
});

test('two owner deliveries waiting behind a refused claim run the turn once, the second attached to the first', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      return openAiText('reply');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'two-owners-1', agentId: 'blair', userMessage: 'first', idempotencyKey: 'k0' });
    const before = calls;
    const repeats: string[] = [];
    const wrong = gateway.dispatch({ sessionId: 'two-owners-1', agentId: 'cora', userMessage: 'hello', idempotencyKey: 'k1' });
    const a = gateway.dispatch({ sessionId: 'two-owners-1', agentId: 'blair', userMessage: 'hello', idempotencyKey: 'k1', onRepeat: (kind) => repeats.push(`a: ${kind}`) });
    const b = gateway.dispatch({ sessionId: 'two-owners-1', agentId: 'blair', userMessage: 'hello', idempotencyKey: 'k1', onRepeat: (kind) => repeats.push(`b: ${kind}`) });
    await assert.rejects(wrong, /belongs to agent blair, not cora/);
    await a;
    await b;
    assert.equal(calls - before, 1);
    assert.deepEqual(repeats, ['b: live']);
  } finally {
    await gateway.stop();
  }
});

test('holdsMessage says whether a session has started a turn for a key, across a recent rollover too', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => openAiText('reply')) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    assert.equal(await gateway.holdsMessage('holds-1', 'k1'), false);
    await gateway.dispatch({ sessionId: 'holds-1', agentId: 'blair', userMessage: 'hello', idempotencyKey: 'k1' });
    assert.equal(await gateway.holdsMessage('holds-1', 'k1'), true);
    assert.equal(await gateway.holdsMessage('holds-1', 'k2'), false);
    await gateway.rolloverSession('holds-1');
    assert.equal(await gateway.holdsMessage('holds-1', 'k1'), true);
  } finally {
    await gateway.stop();
  }
});

test('holdsMessage counts a dispatch still queued behind another turn, and not a turn nobody asked for', async () => {
  const home = await newHome();
  await writeSoul(home, 'blair.md', '---\nname: Blair\nprovider: openai\nmodel: model-a\n---\n\nYou are Blair.\n');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async () => {
      calls += 1;
      if (calls === 1) {
        started();
        await held;
      }
      return openAiText('reply');
    }) as typeof fetch,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();
  try {
    const first = gateway.dispatch({ sessionId: 'holds-q', agentId: 'blair', userMessage: 'first', idempotencyKey: 'k0' });
    await running;
    const queued = gateway.dispatch({ sessionId: 'holds-q', agentId: 'blair', userMessage: 'second', idempotencyKey: 'k1' });
    const judged = gateway.dispatch({ sessionId: 'holds-q', agentId: 'blair', userMessage: 'overheard', idempotencyKey: 'k3', addressed: false });
    assert.equal(await gateway.holdsMessage('holds-q', 'k1'), true);
    assert.equal(await gateway.holdsMessage('holds-q', 'k3'), false);
    release();
    await first;
    await queued;
    await judged;
    await gateway.dispatch({ sessionId: 'holds-q', agentId: 'blair', userMessage: 'aside', idempotencyKey: 'k2', addressed: false });
    assert.equal(await gateway.holdsMessage('holds-q', 'k2'), false);
  } finally {
    release();
    await gateway.stop();
  }
});

test('an agent with its own budget gets it, and the rest keep the shared one', async () => {
  // Same model for both, so only the budget tells their runners apart: one
  // runner shared across them would hand one the other's limit.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-a\n---\n\nYou are Bea.\n');
  const toolTurns = new Map<string, number>();
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o' },
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body);
      const who = body.includes('You are Ava.') ? 'ava' : 'bea';
      if (body.includes('You have used every step this message allows')) {
        return openAiText('wrapped up');
      }
      toolTurns.set(who, (toolTurns.get(who) ?? 0) + 1);
      return openAiToolCall('demo.echo', { text: 'again' });
    }) as typeof fetch,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    maxTurns: 2,
    maxTurnsFor: (agentId) => (agentId === 'ava' ? 5 : undefined),
    approvals: () => ({ approve: async () => true }),
    warn: () => {},
  });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'ava-long', agentId: 'ava', userMessage: 'keep going' });
    await gateway.dispatch({ sessionId: 'bea-short', agentId: 'bea', userMessage: 'keep going' });
    assert.equal(toolTurns.get('ava'), 5);
    assert.equal(toolTurns.get('bea'), 2);
  } finally {
    await gateway.stop();
  }
});
