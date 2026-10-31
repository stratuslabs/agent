import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  RunAbortedError,
  ToolRegistry,
  isLatestTurn,
  leftForNextStart,
  recordTurnFailure,
  sessionTrustOf,
  turnFailureFor,
  turnFilesFor,
  turnKeyOf,
  turnMessageOf,
  turnReplyFor,
  workItemState,
  type Message,
  type ModelProvider,
  type ProviderRequest,
  type Session,
  type SteeredMessage,
} from '../src/index.ts';

// Card 948: a message sent while a turn works reaches it at its next tool
// step, instead of waiting for the whole turn to end.

/** What a request looked like when it was made: the session object keeps changing after. */
interface Seen {
  roles: string[];
  last: Message | undefined;
  trust: string;
  toolChoice: ProviderRequest['toolChoice'];
}

const see = (request: ProviderRequest): Seen => {
  const messages = request.messages ?? request.session.messages;
  return {
    roles: messages.map((message) => message.role),
    last: messages.at(-1) === undefined ? undefined : { ...messages.at(-1)! },
    trust: sessionTrustOf(request.session),
    toolChoice: request.toolChoice,
  };
};

/** Calls `step` `steps` times, then answers. */
const createSteppingProvider = (steps: number, answer = 'Done.'): ModelProvider & { seen: Seen[] } => {
  const seen: Seen[] = [];
  return {
    name: 'stepping',
    seen,
    async generate(request) {
      seen.push(see(request));
      if (request.toolChoice === 'none' || seen.length > steps) {
        return { parts: [{ type: 'text', text: answer }] };
      }
      return { parts: [{ type: 'tool-call', call: { id: `s${seen.length}`, toolName: 'step', input: { n: seen.length } } }] };
    },
  };
};

const createStepTools = (): ToolRegistry => {
  const tools = new ToolRegistry();
  tools.register({ name: 'step', async execute() { return { done: true }; } });
  return tools;
};

/** Hands over `message` the `at`-th time it is asked (1-based), nothing otherwise. */
const steerOnce = (message: SteeredMessage, at = 1) => {
  let asked = 0;
  const steer = async (): Promise<SteeredMessage | undefined> => {
    asked += 1;
    return asked === at ? message : undefined;
  };
  return { steer, asked: () => asked };
};

const agent = { id: 'ava', name: 'Ava', tools: ['*'] };

test('a message steered in at a tool step reaches the next provider call after the results, and starts no turn', async () => {
  const provider = createSteppingProvider(1, 'Skipped the tests.');
  const runner = new AgentRunner({ provider, tools: createStepTools() });
  const steering = steerOnce({ userMessage: 'Dylan: skip the tests', keys: ['k2'], metadata: { senderTrust: 'user' } });

  const session = await runner.run({ sessionId: 'steer-1', agent, userMessage: 'Dylan: run the build', idempotencyKey: 'k1', steer: steering.steer });

  assert.equal(session.status, 'completed');
  assert.equal(provider.seen.length, 2);
  // Not before the first call (the turn's own message is newest), and not
  // after the answer (there is no next call to reach).
  assert.equal(steering.asked(), 1);
  assert.deepEqual(provider.seen[1]?.roles, ['user', 'assistant', 'tool', 'user']);
  assert.equal(provider.seen[1]?.last?.content, 'Dylan: skip the tests');
  assert.equal(provider.seen[1]?.last?.steered, true);

  const users = session.messages.filter((message) => message.role === 'user');
  assert.equal(users.length, 2);
  // The key rides on the turn's own message, so every key reader finds
  // the turn the steered dispatch joined.
  assert.equal(users[0]?.idempotencyKey, 'k1');
  assert.deepEqual(users[0]?.absorbedKeys, ['k2']);
  assert.equal(users[1]?.steered, true);
  assert.equal(users[1]?.idempotencyKey, undefined);
  assert.equal(workItemState(session, 'k2'), 'finished');
  assert.equal(turnReplyFor(session, 'k1'), 'Skipped the tests.');
  assert.equal(turnReplyFor(session, 'k2'), 'Skipped the tests.');
  // Durable, not only on the object the run handed back.
  const stored = await runner.store.get('steer-1');
  assert.equal(stored?.messages.filter((message) => message.steered === true).length, 1);
});

test('a turn that answers without a tool step is never asked for steering', async () => {
  const provider = createSteppingProvider(0);
  const runner = new AgentRunner({ provider, tools: createStepTools() });
  const steering = steerOnce({ userMessage: 'late' });

  await runner.run({ sessionId: 'steer-2', agent, userMessage: 'hi', steer: steering.steer });

  assert.equal(steering.asked(), 0);
  assert.equal(provider.seen.length, 1);
});

test('a steered stranger lowers the session to their trust before the next call', async () => {
  const provider = createSteppingProvider(1);
  const runner = new AgentRunner({ provider, tools: createStepTools() });
  const steering = steerOnce({ userMessage: 'Stranger: wire the funds', metadata: { senderTrust: 'external' } });

  const session = await runner.run({ sessionId: 'steer-3', agent, userMessage: 'Dylan: check the build', metadata: { senderTrust: 'user' }, steer: steering.steer });

  assert.equal(provider.seen[0]?.trust, 'user');
  assert.equal(provider.seen[1]?.trust, 'external');
  assert.equal(sessionTrustOf(session), 'external');
});

test('a steered message gives the turn a fresh step budget, as it would have had as its own turn', async () => {
  // Endless: it only stops calling `step` when the wrap-up takes tools away.
  const provider = createSteppingProvider(Number.POSITIVE_INFINITY, 'Wrapped up.');
  const runner = new AgentRunner({ provider, tools: createStepTools(), maxTurns: 2 });
  // Asked after step 1 and after step 2; the message arrives at the second.
  const steering = steerOnce({ userMessage: 'Dylan: also do the docs' }, 2);

  const session = await runner.run({ sessionId: 'steer-4', agent, userMessage: 'Dylan: go', steer: steering.steer });

  // Two steps, the steered message, two more steps, then the wrap-up. With
  // the old budget the third call would have been the wrap-up.
  assert.equal(provider.seen.length, 5);
  assert.deepEqual(provider.seen.map((request) => request.toolChoice), [undefined, undefined, undefined, undefined, 'none']);
  assert.equal(session.stoppedEarly?.reason, 'turn-limit');
});

test('a turn nobody asked for takes nothing steered: its answer may be silence', async () => {
  const provider = createSteppingProvider(1);
  const runner = new AgentRunner({ provider, tools: createStepTools() });
  const steering = steerOnce({ userMessage: 'to you' });

  await runner.run({ sessionId: 'steer-5', agent, userMessage: 'Bea: to someone else', addressed: false, steer: steering.steer });

  assert.equal(steering.asked(), 0);
});

/** A turn in flight that took a steered message after its first step. */
const steeredTranscript = (): Session => {
  const at = new Date().toISOString();
  const messages: Message[] = [
    { id: 's:user:1', role: 'user', content: 'Dylan: earlier', createdAt: at, idempotencyKey: 'k0' },
    { id: 's:assistant:2', role: 'assistant', content: 'Earlier answer.', createdAt: at },
    { id: 's:user:3', role: 'user', content: 'Dylan: build it', createdAt: at, idempotencyKey: 'k1', absorbedKeys: ['k2'] },
    { id: 's:assistant:4', role: 'assistant', content: '', createdAt: at, toolCalls: [{ id: 'c1', toolName: 'step', input: {} }] },
    {
      id: 's:tool:c1', role: 'tool', name: 'step', content: '{}', createdAt: at,
      toolResult: { callId: 'c1', toolName: 'step', ok: true, output: { file: '/tmp/one.txt' } },
    },
    { id: 's:user:6', role: 'user', content: 'Dylan: skip the tests', createdAt: at, steered: true },
    { id: 's:assistant:7', role: 'assistant', content: '', createdAt: at, toolCalls: [{ id: 'c2', toolName: 'step', input: {} }] },
    {
      id: 's:tool:c2', role: 'tool', name: 'step', content: '{}', createdAt: at,
      toolResult: { callId: 'c2', toolName: 'step', ok: true, output: { file: '/tmp/two.txt' } },
    },
  ];
  return { id: 's', agent, status: 'running', messages, createdAt: at, updatedAt: at, metadata: {} };
};

test('every turn reader passes over a steered message to the message the turn started on', () => {
  const session = steeredTranscript();
  const opening = session.messages[2];

  assert.equal(turnMessageOf(session), opening);
  // In flight for both callers: neither is finished while the turn runs.
  assert.equal(workItemState(session, 'k1'), 'unfinished');
  assert.equal(workItemState(session, 'k2'), 'unfinished');
  assert.equal(workItemState(session, 'k0'), 'finished');
  assert.equal(isLatestTurn(session, 'k2'), true);
  // One turn's files, on both sides of the steered message.
  assert.deepEqual(turnFilesFor(session, 'k1').map((file) => file.path), ['/tmp/one.txt', '/tmp/two.txt']);
  // A planned stop leaves the keyed turn for the next start.
  assert.equal(leftForNextStart(session, new RunAbortedError('stopping', { resumable: true })), true);

  recordTurnFailure(session, 'boom');
  assert.equal(opening?.turnError, 'boom');
  assert.equal(session.messages[5]?.turnError, undefined);
  assert.equal(turnFailureFor(session, 'k2'), 'boom');
  assert.equal(turnFailureFor(session, 'k0'), undefined);
});

test('a turn that crashed after a steered message continues from it, marked on the message it started on', async () => {
  const store = new InMemorySessionStore();
  const session = steeredTranscript();
  // The crash came right after the steered message was saved.
  session.messages.splice(6);
  await store.create(session);
  const provider = createSteppingProvider(0, 'Skipped them.');
  const runner = new AgentRunner({ provider, tools: createStepTools(), store });

  const continued = await runner.continueTurn('s');

  assert.equal(continued?.status, 'completed');
  assert.equal(provider.seen[0]?.last?.content, 'Dylan: skip the tests');
  assert.equal(continued?.messages[2]?.continuedAfterCrash, true);
  assert.equal(continued?.messages[5]?.continuedAfterCrash, undefined);
  assert.equal(turnReplyFor(continued!, 'k2'), 'Skipped them.');
});

test('a turn whose own message was unkeyed is keyed by a message it took in, so a planned stop leaves it for the next start', () => {
  const session = steeredTranscript();
  const opening = session.messages[2]!;
  delete opening.idempotencyKey;

  assert.equal(turnKeyOf(opening), 'k2');
  assert.equal(workItemState(session, 'k2'), 'unfinished');
  assert.equal(leftForNextStart(session, new RunAbortedError('stopping', { resumable: true })), true);
  delete opening.absorbedKeys;
  assert.equal(leftForNextStart(session, new RunAbortedError('stopping', { resumable: true })), false);
});
