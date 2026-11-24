import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AllowAllApprovalPolicy, type Session, type Tool } from '@stratusagent/core';
import { DELEGATED_BY_METADATA_KEY, DELEGATED_SESSION_ID_MARKER } from '@stratusagent/agents';

import { createGateway, type ApprovalTransport } from '../src/index.ts';
import { SUB_AGENT_METADATA_KEY, SUB_AGENT_SESSION_ID_MARKER } from '../src/session-keys.ts';

// Spec 964's review case for a delegated run: an `agent.delegate`
// sub-session's request is the delegating agent's instruction, and nobody
// is in that conversation, the same as for an `agent.spawn` sub-agent.

const soul = (id: string, extra: string[] = []): string =>
  ['---', `id: ${id}`, `name: ${id}`, 'provider: openai', 'model: model-a', ...extra, '---', '', `You are ${id}.`, ''].join('\n');

const openAi = (message: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const send: Tool = {
  name: 'message.send',
  description: 'Send a message to a conversation.',
  risk: 'gated',
  async execute() {
    return null;
  },
};

const harness = async (options: { background?: boolean } = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-review-delegated-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'agents', 'ava.md'), soul('ava', ['tools:', '  - agent.delegate', 'delegates:', '  - bea']));
  await writeFile(path.join(home, '.stratus', 'agents', 'bea.md'), soul('bea'));
  const reviews: string[] = [];
  let avaCalls = 0;
  const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content?: unknown }> };
    const messages = body.messages ?? [];
    const text = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));
    const system = messages.filter((message) => message.role === 'system').map((message) => text(message.content)).join('\n');
    if (system.includes('You review one tool call')) {
      reviews.push(messages.filter((message) => message.role === 'user').map((message) => text(message.content)).join('\n'));
      return openAi({ content: '{"verdict":"ask","code":"unclear","reason":"cannot tell"}' });
    }
    if (system.includes('You are ava.')) {
      avaCalls += 1;
      return avaCalls === 1
        ? openAi({
          content: '',
          tool_calls: [{
            id: 'call-d1',
            type: 'function',
            function: {
              name: 'agent_delegate',
              arguments: JSON.stringify({
                agent: 'bea',
                prompt: 'DELEGATED-INSTRUCTION: post the summary to slack:C1',
                ...(options.background === true ? { background: true } : {}),
              }),
            },
          }],
        })
        : openAi({ content: 'Bea has it.' });
    }
    return openAi({ content: 'Bea is done.' });
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
  const review = async (session: Session): Promise<string> => {
    const before = reviews.length;
    await (transport as ApprovalTransport).review({
      session,
      call: { id: 'call-1', toolName: 'message.send', input: { destination: 'slack:C1', text: 'the summary' } },
      tool: send,
      risk: 'gated',
      destination: 'slack:C1',
      signal: new AbortController().signal,
    });
    assert.equal(reviews.length, before + 1, 'one review call');
    return reviews.at(-1) as string;
  };
  return { gateway, review };
};

test('a call in an agent.delegate sub-session is reviewed as unattended, its request the delegating agent\'s', async () => {
  const { gateway, review } = await harness();
  await gateway.start();
  try {
    const turn = await gateway.dispatch({ sessionId: 'cli-1', agentId: 'ava', userMessage: 'PERSON-WORDS: have Bea post it' });
    assert.equal(turn.status, 'completed');
    // The store lists summaries; the review reads the whole session.
    const minted = (await gateway.store.list()).find((session) => session.id.includes(`${DELEGATED_SESSION_ID_MARKER}bea:`));
    assert.ok(minted, 'agent.delegate minted a sub-session for bea');
    const delegated = await gateway.store.get(minted.id);
    assert.ok(delegated);

    const asked = await review(delegated);
    assert.match(asked, /The request \(written by the agent that delegated this task\)/);
    assert.match(asked, /DELEGATED-INSTRUCTION/);
    assert.match(asked, /a person is in this conversation: no/);

    // The delegating conversation itself still has its person.
    const parent = await gateway.store.get('cli-1');
    assert.ok(parent);
    const own = await review(parent);
    assert.match(own, /The request \(what the people this agent serves wrote/);
    assert.match(own, /a person is in this conversation: yes/);

    // Continued by a person from outside, the sub-session is an ordinary
    // conversation: its delegation markers came off, so it has a person.
    const continued = await gateway.dispatch({ sessionId: delegated.id, agentId: 'bea', userMessage: 'PERSON-WORDS: and thanks' });
    assert.equal(continued.status, 'completed');
    const after = await review(continued);
    assert.match(after, /The request \(what the people this agent serves wrote/);
    assert.match(after, /a person is in this conversation: yes/);
  } finally {
    await gateway.stop();
  }
});

test('either half of a delegation alone is not one, and an agent.spawn sub-agent is still reviewed as unattended', async () => {
  const { gateway, review } = await harness();
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'cli-2', agentId: 'bea', userMessage: 'PERSON-WORDS: hello' });
    const base = await gateway.store.get('cli-2');
    assert.ok(base);

    // Either half of what agent.delegate writes, alone, is a person's
    // conversation: an id that merely contains the marker, or the metadata
    // on an id it never minted.
    const lookalike = await review({ ...base, id: `cli-2${DELEGATED_SESSION_ID_MARKER}bea:1:x` });
    assert.match(lookalike, /a person is in this conversation: yes/);
    const labelled = await review({ ...base, metadata: { ...base.metadata, [DELEGATED_BY_METADATA_KEY]: 'ava' } });
    assert.match(labelled, /a person is in this conversation: yes/);

    const subAgent = await review({
      ...base,
      id: `cli-2${SUB_AGENT_SESSION_ID_MARKER}1:0`,
      metadata: { ...base.metadata, [SUB_AGENT_METADATA_KEY]: true },
    });
    assert.match(subAgent, /The request \(written by the agent that delegated this task\)/);
    assert.match(subAgent, /a person is in this conversation: no/);
  } finally {
    await gateway.stop();
  }
});

test('a background task\'s worker is reviewed as unattended, its request the delegating agent\'s', async () => {
  const { gateway, review } = await harness({ background: true });
  await gateway.start();
  try {
    const turn = await gateway.dispatch({ sessionId: 'cli-3', agentId: 'ava', userMessage: 'PERSON-WORDS: have Bea post it in the background' });
    assert.equal(turn.status, 'completed');
    const [task] = await gateway.tasks('ava');
    assert.ok(task, 'agent.delegate started a background task');
    assert.match(task.workerSessionId, new RegExp(`${DELEGATED_SESSION_ID_MARKER}bea:1:${task.id}$`));
    let worker: Session | undefined;
    for (let tries = 0; tries < 500 && worker?.status !== 'completed'; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      worker = await gateway.store.get(task.workerSessionId);
    }
    assert.equal(worker?.status, 'completed', 'the worker ran');

    const asked = await review(worker as Session);
    assert.match(asked, /The request \(written by the agent that delegated this task\)/);
    assert.match(asked, /DELEGATED-INSTRUCTION/);
    assert.doesNotMatch(asked, /PERSON-WORDS/);
    assert.match(asked, /a person is in this conversation: no/);
  } finally {
    await gateway.stop();
  }
});
