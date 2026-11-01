import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  ToolRegistry,
  sessionTrustOf,
  type ModelProvider,
  type ProviderRequest,
  type SteeredMessage,
} from '../src/index.ts';

// Card 958: a provider that runs its own tool loop (Claude Code) never
// hands the runner its steps, so it asks for what was said mid-task itself,
// right after a hosted call's result, through `ProviderRequest.steer`.

const agent = { id: 'ava', name: 'Ava' };

const createStepTools = (): ToolRegistry => {
  const tools = new ToolRegistry();
  tools.register({ name: 'step', async execute() { return { done: true }; } });
  return tools;
};

/** Hands over `message` the first time it is asked, nothing after. */
const steerOnce = (message: SteeredMessage) => {
  let asked = 0;
  const steer = async (): Promise<SteeredMessage | undefined> => {
    asked += 1;
    return asked === 1 ? message : undefined;
  };
  return { steer, asked: () => asked };
};

/**
 * A harness: runs `step` through the host the way provider-claude-code
 * does, then asks `request.steer` once its result is in. `before` asks
 * first, ahead of any tool.
 */
const createHostedProvider = (getRunner: () => AgentRunner, options: { before?: boolean; abort?: AbortController } = {}) => {
  const offered: boolean[] = [];
  const taken: Array<SteeredMessage | undefined> = [];
  const provider: ModelProvider = {
    name: 'hosted',
    async generate(request: ProviderRequest) {
      offered.push(request.steer !== undefined);
      if (options.before === true) {
        taken.push(await request.steer?.());
      }
      await getRunner().executeHostedToolCall(request.session, { id: 'h1', toolName: 'step', input: {} });
      options.abort?.abort();
      taken.push(await request.steer?.());
      return { parts: [{ type: 'text', text: 'Done, and skipped the tests.' }] };
    },
  };
  return { provider, offered, taken };
};

test('a harness asks for a steered message after a hosted call: it is recorded right after that result, keys and trust included', async () => {
  let runner!: AgentRunner;
  const hosted = createHostedProvider(() => runner);
  runner = new AgentRunner({ provider: hosted.provider, tools: createStepTools() });
  const message: SteeredMessage = { userMessage: 'Mallory: skip the tests', keys: ['k2'], metadata: { senderTrust: 'external' } };
  const steering = steerOnce(message);

  const session = await runner.run({ sessionId: 'hosted-steer-1', agent, userMessage: 'Dylan: run the build', idempotencyKey: 'k1', hostedLoop: true, steer: steering.steer });

  assert.equal(session.status, 'completed');
  assert.deepEqual(hosted.offered, [true]);
  assert.deepEqual(hosted.taken, [message]);
  assert.deepEqual(session.messages.map((entry) => entry.role), ['user', 'assistant', 'tool', 'user', 'assistant']);
  const steered = session.messages[3]!;
  assert.equal(steered.content, 'Mallory: skip the tests');
  assert.equal(steered.steered, true);
  assert.deepEqual(session.messages[0]!.absorbedKeys, ['k2']);
  assert.equal(sessionTrustOf(session), 'external');
  assert.equal(session.messages.at(-1)!.content, 'Done, and skipped the tests.');
});

test('a harness that asks before any hosted call has a result is handed nothing, and nothing is taken', async () => {
  let runner!: AgentRunner;
  const hosted = createHostedProvider(() => runner, { before: true });
  runner = new AgentRunner({ provider: hosted.provider, tools: createStepTools() });
  const steering = steerOnce({ userMessage: 'Dylan: skip the tests' });

  const session = await runner.run({ sessionId: 'hosted-steer-2', agent, userMessage: 'Dylan: run the build', hostedLoop: true, steer: steering.steer });

  // Asked once, after the call: the early ask took nothing.
  assert.equal(steering.asked(), 1);
  assert.equal(hosted.taken[0], undefined);
  assert.deepEqual(session.messages.map((entry) => entry.role), ['user', 'assistant', 'tool', 'user', 'assistant']);
});

test('a reply-optional turn offers a harness no steer: a question folded in could be lost to its silence', async () => {
  let runner!: AgentRunner;
  const hosted = createHostedProvider(() => runner);
  runner = new AgentRunner({ provider: hosted.provider, tools: createStepTools() });
  const steering = steerOnce({ userMessage: 'Dylan: wait, a question' });

  await runner.run({ sessionId: 'hosted-steer-3', agent, userMessage: 'Blair: report, all green', replyOptional: true, hostedLoop: true, steer: steering.steer });

  assert.deepEqual(hosted.offered, [false]);
  assert.equal(steering.asked(), 0);
});

test('a turn run without steer offers a harness none', async () => {
  let runner!: AgentRunner;
  const hosted = createHostedProvider(() => runner);
  runner = new AgentRunner({ provider: hosted.provider, tools: createStepTools() });

  await runner.run({ sessionId: 'hosted-steer-4', agent, userMessage: 'Dylan: run the build', hostedLoop: true });

  assert.deepEqual(hosted.offered, [false]);
});

test('a stopped turn takes nothing a harness asks for', async () => {
  let runner!: AgentRunner;
  const abort = new AbortController();
  const hosted = createHostedProvider(() => runner, { abort });
  runner = new AgentRunner({ provider: hosted.provider, tools: createStepTools() });
  const steering = steerOnce({ userMessage: 'Dylan: skip the tests' });

  await assert.rejects(runner.run({ sessionId: 'hosted-steer-5', agent, userMessage: 'Dylan: run the build', hostedLoop: true, steer: steering.steer, signal: abort.signal }));

  assert.equal(steering.asked(), 0);
});
