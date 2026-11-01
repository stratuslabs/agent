import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  sessionTrustOf,
  ToolRegistry,
  type ExecutionContext,
  type ModelProvider,
  type ProviderResponse,
  type StratusEvent,
  type Tool,
  type TrustLevel,
} from '../src/index.ts';

/** One `run.tool` call to the named tool, then a closing text turn. */
const oneCall = (toolName: string): ModelProvider => {
  let turn = 0;
  return {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      return turn === 1
        ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName, input: {} } }] }
        : { parts: [{ type: 'text', text: 'done' }] };
    },
  };
};

interface Harness {
  /** The session label the policy saw, once per time it was asked. */
  seen: TrustLevel[];
  /** What `execute` was handed as the decided label, once per run. */
  decided: Array<TrustLevel | undefined>;
  tainted: string[];
  result: { ok: boolean; error?: string } | undefined;
}

const runWith = async (tool: Omit<Tool, 'execute'>, approve: () => boolean = () => true): Promise<Harness> => {
  const harness: Harness = { seen: [], decided: [], tainted: [], result: undefined };
  const tools = new ToolRegistry();
  tools.register({
    ...tool,
    async execute(_input, _session, context?: ExecutionContext) {
      harness.decided.push(context?.decidedTrust);
      return { ran: true };
    },
  });
  const runner = new AgentRunner({
    provider: oneCall(tool.name),
    tools,
    store: new InMemorySessionStore(),
    approvals: {
      approve: async ({ session }) => {
        harness.seen.push(sessionTrustOf(session));
        return approve();
      },
    },
  });
  runner.bus.subscribe((event) => {
    if (event.type === 'session.tainted') {
      harness.tainted.push(`${event.trust}:${event.source}`);
    }
  });
  await runner.initialize();
  const session = await runner.run({ sessionId: `tbc-${tool.name}`, agent: { id: 'ava', name: 'Ava' }, userMessage: 'go' });
  const result = session.messages.find((message) => message.toolResult?.callId === 'c1')?.toolResult;
  harness.result = result ? { ok: result.ok, ...(result.error ? { error: result.error } : {}) } : undefined;
  return harness;
};

test('a tool\'s trustBeforeCall lowers the session before the policy decides, and the decided label reaches execute', async () => {
  const run = await runWith({ name: 'probe.run', risk: 'gated', trustBeforeCall: () => 'external' });
  assert.deepEqual(run.seen, ['external']);
  assert.deepEqual(run.decided, ['external']);
  assert.deepEqual(run.tainted.slice(0, 1), ['external:probe.run']);
  assert.equal(run.result?.ok, true);
});

test('a trustBeforeCall that throws, or never answers, is read as external', async () => {
  const threw = await runWith({ name: 'probe.throws', risk: 'gated', trustBeforeCall: () => { throw new Error('ledger gone'); } });
  assert.deepEqual(threw.seen, ['external']);
  const hung = await runWith({ name: 'probe.hangs', risk: 'gated', trustBeforeCall: () => new Promise<TrustLevel>(() => {}) });
  assert.deepEqual(hung.seen, ['external']);
  assert.deepEqual(hung.decided, ['external']);
});

test('a tool without trustBeforeCall is judged as before', async () => {
  const run = await runWith({ name: 'plain.run', risk: 'gated' });
  assert.equal(run.seen.length, 1);
  assert.notEqual(run.seen[0], 'external');
  assert.deepEqual(run.decided, [run.seen[0]]);
  assert.deepEqual(run.tainted, []);
  assert.equal(run.result?.ok, true);
});

test('a label that drops while the call is being approved is decided again, against the lower label', async () => {
  const labels: TrustLevel[] = ['unknown', 'external', 'external'];
  const run = await runWith({ name: 'probe.drops', risk: 'gated', trustBeforeCall: () => labels.shift() });
  assert.deepEqual(run.seen, ['unknown', 'external']);
  assert.deepEqual(run.decided, ['external']);
  assert.equal(run.result?.ok, true);
});

test('a label that drops again on the second decision refuses the call instead of asking a third time', async () => {
  const labels: TrustLevel[] = ['agent', 'unknown', 'external'];
  const run = await runWith({ name: 'probe.keeps-dropping', risk: 'gated', trustBeforeCall: () => labels.shift() });
  assert.deepEqual(run.seen, ['agent', 'unknown']);
  assert.deepEqual(run.decided, [], 'it never ran');
  assert.equal(run.result?.ok, false);
  assert.match(run.result?.error ?? '', /probe\.keeps-dropping did not run/);
});

test('a denied call is not asked about again when the label drops', async () => {
  const labels: TrustLevel[] = ['unknown', 'external'];
  const run = await runWith({ name: 'probe.denied', risk: 'gated', trustBeforeCall: () => labels.shift() }, () => false);
  assert.deepEqual(run.seen, ['unknown']);
  assert.deepEqual(run.decided, []);
  assert.equal(run.result?.ok, false);
});

test('a call refused for a label that dropped twice reports that refusal as its last decision', async () => {
  // The policy said yes both times, and reported it; the runner's own "no"
  // comes after, so a surface showing the latest decision beside the
  // denied call shows why it was denied, not the two yeses.
  const labels: TrustLevel[] = ['agent', 'unknown', 'external'];
  const tools = new ToolRegistry();
  tools.register({
    name: 'probe.keeps-dropping',
    description: 'probe',
    risk: 'gated',
    trustBeforeCall: () => labels.shift(),
    async execute() {
      return { ran: true };
    },
  });
  const runner = new AgentRunner({
    provider: oneCall('probe.keeps-dropping'),
    tools,
    store: new InMemorySessionStore(),
    approvals: {
      approve: async (context) => {
        context.decided?.({ allowed: true, layer: 'scope', reason: 'probe.keeps-dropping is in scope' });
        return true;
      },
    },
  });
  const events: StratusEvent[] = [];
  runner.bus.subscribe((event) => {
    if (event.type === 'permission.decided' || event.type === 'tool.denied' || event.type === 'tool.called') {
      events.push(event);
    }
  });
  await runner.initialize();
  await runner.run({ sessionId: 'tbc-decided', agent: { id: 'ava', name: 'Ava' }, userMessage: 'go' });
  assert.deepEqual(events.map((event) => event.type), [
    'permission.decided',
    'permission.decided',
    'permission.decided',
    'tool.denied',
  ]);
  const last = events[2];
  assert.equal(last?.type, 'permission.decided');
  if (last?.type !== 'permission.decided') {
    return;
  }
  assert.equal(last.callId, 'c1');
  assert.equal(last.allowed, false);
  assert.equal(last.layer, 'trust');
  assert.match(last.reason, /marked less trusted twice while it was being approved/);
});
