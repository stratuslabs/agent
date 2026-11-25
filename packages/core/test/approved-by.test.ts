import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type ApprovalContext,
  type ApprovalDecision,
  type ExecutionContext,
  type ModelProvider,
  type ProviderResponse,
  type StratusEvent,
  type Tool,
  type TrustLevel,
} from '../src/index.ts';

// A tool learns that a person said yes to this very call through
// `ExecutionContext.approvedBy`, which the runner sets from the policy's own
// report of that decision and from nothing else.

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

interface Run {
  /** What `execute` was handed as `approvedBy`, once per run. */
  approvedBy: Array<string | undefined>;
  events: StratusEvent[];
}

const runWith = async (
  decide: (context: ApprovalContext) => boolean,
  tool: Partial<Tool> = {},
): Promise<Run> => {
  const run: Run = { approvedBy: [], events: [] };
  const tools = new ToolRegistry();
  tools.register({
    name: 'probe.run',
    risk: 'gated',
    ...tool,
    async execute(_input, _session, context?: ExecutionContext) {
      run.approvedBy.push(context?.approvedBy);
      return { ran: true };
    },
  });
  const runner = new AgentRunner({
    provider: oneCall('probe.run'),
    tools,
    store: new InMemorySessionStore(),
    approvals: { approve: async (context) => decide(context) },
  });
  runner.bus.subscribe((event) => {
    run.events.push(event);
  });
  await runner.initialize();
  await runner.run({ sessionId: 'approved-by', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'go' });
  return run;
};

const yes = (approvedBy: unknown, extra: Partial<ApprovalDecision> = {}): ApprovalDecision =>
  ({ allowed: true, layer: 'approver', reason: 'probe.run was approved', approvedBy, ...extra }) as ApprovalDecision;

test('a person\'s yes, as the policy reports it, reaches execute as approvedBy', async () => {
  const run = await runWith((context) => {
    context.decided?.(yes('U-APPROVER'));
    return true;
  });
  assert.deepEqual(run.approvedBy, ['U-APPROVER']);
  // Who approved stays off the bus: the event is a trace of decisions.
  const decided = run.events.filter((event) => event.type === 'permission.decided');
  assert.equal(decided.length, 1);
  assert.doesNotMatch(JSON.stringify(decided), /U-APPROVER/);
});

test('an allow that names nobody, a shadow report, a blank name or no report leaves approvedBy unset', async () => {
  const unnamed = await runWith((context) => {
    context.decided?.({ allowed: true, layer: 'grant', reason: 'covered by a standing grant' });
    return true;
  });
  assert.deepEqual(unnamed.approvedBy, [undefined]);

  const shadow = await runWith((context) => {
    context.decided?.(yes('U-APPROVER', { shadow: true }));
    return true;
  });
  assert.deepEqual(shadow.approvedBy, [undefined]);

  const blank = await runWith((context) => {
    context.decided?.(yes(''));
    return true;
  });
  assert.deepEqual(blank.approvedBy, [undefined]);

  const notAString = await runWith((context) => {
    context.decided?.(yes(42));
    return true;
  });
  assert.deepEqual(notAString.approvedBy, [undefined]);

  const silent = await runWith(() => true);
  assert.deepEqual(silent.approvedBy, [undefined]);
});

test('a refusal that names a person is not a yes, even when the policy then answers true', async () => {
  const run = await runWith((context) => {
    context.decided?.({ allowed: false, layer: 'approver', reason: 'refused', approvedBy: 'U-APPROVER' } as ApprovalDecision);
    return true;
  });
  assert.deepEqual(run.approvedBy, [undefined]);
});

test('when the label drops and the call is decided again, only the second decision counts', async () => {
  // First a person's yes, then, decided again against the lower label, a grant.
  const labels: TrustLevel[] = ['unknown', 'external', 'external'];
  const reports = [yes('U-APPROVER'), { allowed: true, layer: 'grant', reason: 'covered' } as ApprovalDecision];
  const run = await runWith((context) => {
    context.decided?.(reports.shift()!);
    return true;
  }, { trustBeforeCall: () => labels.shift() });
  assert.deepEqual(run.approvedBy, [undefined]);

  // And the other way round.
  const again: TrustLevel[] = ['unknown', 'external', 'external'];
  const later = [{ allowed: true, layer: 'grant', reason: 'covered' } as ApprovalDecision, yes('U-APPROVER')];
  const second = await runWith((context) => {
    context.decided?.(later.shift()!);
    return true;
  }, { trustBeforeCall: () => again.shift() });
  assert.deepEqual(second.approvedBy, ['U-APPROVER']);
});
