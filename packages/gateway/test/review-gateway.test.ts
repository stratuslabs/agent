import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AllowAllApprovalPolicy, type Tool } from '@stratusagent/core';

import { createGateway, type ApprovalTransport } from '../src/index.ts';
import { REVIEW_RULES } from '../src/review.ts';

// Spec 964 through the daemon: the review posture's reviewer is one model
// call on the agent's provider, with no tools and exactly the model named.

const SOUL = ['---', 'id: ava', 'name: Ava', 'provider: openai', 'model: model-a', '---', '', 'You are Ava, PERSONA-MARKER.', ''].join('\n');

const openAiText = (text: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

interface Seen {
  model: string;
  system: string;
  user: string;
  tools: number;
}

const send: Tool = {
  name: 'message.send',
  description: 'Send a message to a conversation.',
  risk: 'gated',
  async execute() {
    return null;
  },
};

const reviewGateway = async (reviewer: () => Response) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-review-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'agents', 'ava.md'), SOUL);
  const reviews: Seen[] = [];
  const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      model?: string;
      messages?: Array<{ role: string; content?: unknown }>;
      tools?: unknown[];
    };
    const text = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));
    const messages = body.messages ?? [];
    const system = messages.filter((message) => message.role === 'system').map((message) => text(message.content)).join('\n');
    if (system.includes('You review one tool call')) {
      reviews.push({
        model: body.model ?? '',
        system,
        user: messages.filter((message) => message.role === 'user').map((message) => text(message.content)).join('\n'),
        tools: (body.tools ?? []).length,
      });
      return reviewer();
    }
    return openAiText('Noted, AGENT-TEXT-MARKER.');
  }) as typeof fetch;
  let transport: ApprovalTransport | undefined;
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchFake },
    idleTimeoutMs: 0,
    approvals: (given) => {
      transport = given;
      return new AllowAllApprovalPolicy();
    },
    log: () => undefined,
    warn: () => undefined,
  });
  return { gateway, reviews, transport: () => transport as ApprovalTransport };
};

const ask = async (harness: Awaited<ReturnType<typeof reviewGateway>>, model?: string) => {
  const session = await harness.gateway.store.get('cli-1');
  assert.ok(session);
  return harness.transport().review({
    session,
    call: { id: 'call-1', toolName: 'message.send', input: { destination: 'slack:C1', text: 'the summary' } },
    tool: send,
    risk: 'gated',
    destination: 'slack:C1',
    ...(model !== undefined ? { model } : {}),
    signal: new AbortController().signal,
  });
};

test('the reviewer runs on the agent\'s provider with its own rules, no tools, and the people\'s words only', async () => {
  const harness = await reviewGateway(() => openAiText('```json\n{"verdict":"allow","code":"asked-for","reason":"they asked to post it"}\n```'));
  await harness.gateway.start();
  try {
    const turn = await harness.gateway.dispatch({ sessionId: 'cli-1', agentId: 'ava', userMessage: 'Post the summary in #eng, slack:C1' });
    assert.equal(turn.status, 'completed');
    const answer = await ask(harness);
    assert.deepEqual(answer, { reply: { verdict: 'allow', code: 'asked-for', reason: 'they asked to post it' } });
    const [seen] = harness.reviews;
    assert.ok(seen, 'no review call was made');
    assert.equal(seen.model, 'model-a', 'the agent\'s own model by default');
    assert.equal(seen.tools, 0);
    assert.ok(seen.system.includes(REVIEW_RULES.split('\n')[0] as string));
    assert.doesNotMatch(seen.system, /PERSONA-MARKER/, 'no persona');
    assert.match(seen.user, /Post the summary in #eng/);
    assert.match(seen.user, /destination named: slack:C1/);
    assert.doesNotMatch(seen.user, /AGENT-TEXT-MARKER/, 'never the agent\'s own text');

    await ask(harness, 'model-cheap');
    assert.equal(harness.reviews.at(-1)?.model, 'model-cheap', 'exactly the model named');
    const stored = await harness.gateway.store.list();
    assert.ok(stored.every((session) => !session.id.startsWith('review:')), 'a review session is never stored');
  } finally {
    await harness.gateway.stop();
  }
});

test('a reply that is not one JSON object, or a provider that fails, is a failed review', async () => {
  let reply = (): Response => openAiText('I think this is fine.');
  const harness = await reviewGateway(() => reply());
  await harness.gateway.start();
  try {
    await harness.gateway.dispatch({ sessionId: 'cli-1', agentId: 'ava', userMessage: 'hello' });
    assert.deepEqual(await ask(harness), { failed: 'unparseable' });
    reply = () => new Response('{"error":{"message":"overloaded"}}', { status: 500, headers: { 'content-type': 'application/json' } });
    assert.deepEqual(await ask(harness), { failed: 'provider-error' });
  } finally {
    await harness.gateway.stop();
  }
});
