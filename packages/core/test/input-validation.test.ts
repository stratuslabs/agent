import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  inputProblem,
  ToolRegistry,
  type ModelProvider,
  type ProviderResponse,
  type Tool,
} from '../src/index.ts';

const SEND_SCHEMA = {
  type: 'object',
  properties: {
    destination: {
      type: 'object',
      properties: { channel: { type: 'string' }, to: { type: 'string' } },
      required: ['channel', 'to'],
    },
    text: { type: 'string' },
    mode: { type: 'string', enum: ['now', 'later'] },
    count: { type: 'integer' },
  },
  required: ['destination', 'text'],
};

test('inputProblem names the first thing wrong with a call, and nothing when the shape fits', () => {
  assert.equal(inputProblem(SEND_SCHEMA, { destination: { channel: 'slack', to: 'C1' }, text: 'hi' }), undefined);
  assert.equal(inputProblem(SEND_SCHEMA, { destination: { kind: 'slack', id: 'C1' }, text: 'hi' }), 'input.destination is missing "channel"');
  assert.equal(inputProblem(SEND_SCHEMA, { text: 'hi' }), 'input is missing "destination"');
  assert.equal(inputProblem(SEND_SCHEMA, { destination: 'C1', text: 'hi' }), 'input.destination should be object, not string');
  assert.equal(inputProblem(SEND_SCHEMA, { destination: { channel: 'slack', to: 'C1' }, text: 'hi', mode: 'soon' }), 'input.mode should be one of "now", "later"');
  assert.equal(inputProblem(SEND_SCHEMA, { destination: { channel: 'slack', to: 'C1' }, text: 'hi', count: 1.5 }), 'input.count should be integer, not number');
  assert.match(inputProblem({ ...SEND_SCHEMA, additionalProperties: false }, { destination: { channel: 'slack', to: 'C1' }, text: 'hi', extra: 1 }) ?? '', /has "extra"/);
  // Enum values compare as JSON, member order aside.
  assert.equal(inputProblem({ enum: [{ a: 1, b: [1, 2] }] }, { b: [1, 2], a: 1 }), undefined);
  assert.match(inputProblem({ enum: [{ a: 1 }] }, { a: 2 }) ?? '', /should be one of/);
  // A key patternProperties declares is not an extra one.
  const patterned = { type: 'object', properties: { name: { type: 'string' } }, patternProperties: { '^x-': {} }, additionalProperties: false };
  assert.equal(inputProblem(patterned, { name: 'a', 'x-trace': 'b' }), undefined);
  // No pattern a schema supplies is ever run: with patternProperties, extra
  // keys are not judged at all (a catastrophic pattern returns at once).
  assert.equal(inputProblem(patterned, { name: 'a', other: 'b' }), undefined);
  const evil = { type: 'object', patternProperties: { '^(a+)+$': {} }, additionalProperties: false };
  const started = Date.now();
  assert.equal(inputProblem(evil, { [`${'a'.repeat(40)}!`]: 1 }), undefined);
  assert.ok(Date.now() - started < 100);
  // A pathologically deep enum value doesn't overflow the stack.
  const nested = (levels: number): Record<string, unknown> => {
    const top: Record<string, unknown> = {};
    let at = top;
    for (let level = 0; level < levels; level += 1) {
      const next: Record<string, unknown> = {};
      at.n = next;
      at = next;
    }
    return top;
  };
  assert.equal(inputProblem({ enum: [nested(5000)] } as never, nested(5000) as never), undefined);
  // What it doesn't read is not a failure.
  assert.equal(inputProblem(undefined, { anything: true }), undefined);
  assert.equal(inputProblem({ type: 'object', properties: { x: { minLength: 3 } } }, { x: 'a' }), undefined);
});

test('a malformed gated call is answered with the reason and never reaches the approval policy', async () => {
  const sent: unknown[] = [];
  const send: Tool = {
    name: 'message.send',
    risk: 'gated',
    parameters: SEND_SCHEMA,
    async execute(input) {
      sent.push(input);
      return { ok: true };
    },
  };
  const tools = new ToolRegistry();
  tools.register(send);
  const asked: string[] = [];
  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      if (turn === 1) {
        return { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'message.send', input: { destination: { kind: 'slack', id: 'C1' }, text: 'hi' } } }] };
      }
      if (turn === 2) {
        return { parts: [{ type: 'tool-call', call: { id: 'c2', toolName: 'message.send', input: { destination: { channel: 'slack', to: 'C1' }, text: 'hi' } } }] };
      }
      return { parts: [{ type: 'text', text: 'done' }] };
    },
  };
  const runner = new AgentRunner({
    provider,
    tools,
    store: new InMemorySessionStore(),
    approvals: { approve: async ({ call }) => { asked.push(call.id); return true; } },
  });
  await runner.initialize();
  const session = await runner.run({ sessionId: 'v-1', agent: { id: 'ava', name: 'Ava' }, userMessage: 'send it' });

  assert.deepEqual(asked, ['c2'], 'only the well-formed call was put to the policy');
  assert.equal(sent.length, 1);
  const first = session.messages.find((message) => message.toolResult?.callId === 'c1')?.toolResult;
  assert.equal(first?.ok, false);
  assert.match(first?.error ?? '', /Invalid input for message\.send: input\.destination is missing "channel"/);
});
