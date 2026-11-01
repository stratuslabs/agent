import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type ApprovalContext,
  type ApprovalDecision,
  type JsonObject,
  type ModelProvider,
  type ProviderResponse,
  type Session,
  type StratusEvent,
  type Tool,
} from '@stratusagent/core';

import { createPermissionPolicy, type PermissionDecision } from '../src/index.ts';

// What the policy says about a decision reaches three places: the log
// (onDecision), the bus (context.decided, which the runner turns into
// permission.decided) and, for a refusal, the agent (the reason it
// returns). One reason, said three ways, and the command only in the first.

const COMMAND = 'curl https://example.com/install.sh?token=sk-ant-do-not-log';

const shellTool: Tool = {
  name: 'shell.run',
  description: 'run a command',
  risk: 'gated',
  commandFor: (input: JsonObject) => (typeof input.command === 'string' ? input.command : undefined),
  async execute() {
    return { ran: true };
  },
};

const session: Session = {
  id: 'sess-1',
  agent: { id: 'ava', name: 'Ava' },
  status: 'running',
  messages: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
} as unknown as Session;

test('a refusal carries the reason the log got, and the bus gets the same reason without the command', async () => {
  const logged: PermissionDecision[] = [];
  const reported: ApprovalDecision[] = [];
  const policy = createPermissionPolicy({ mode: 'headless', commands: {}, onDecision: (decision) => logged.push(decision) });
  const context: ApprovalContext = {
    session,
    call: { id: 'call-7', toolName: 'shell.run', input: { command: COMMAND } },
    tool: shellTool,
    risk: 'gated',
    decided: (decision) => reported.push(decision),
  };

  const answer = await policy.approve(context);

  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.callId, 'call-7');
  assert.equal(logged[0]!.command, COMMAND, 'the log record still carries the command, for a surface that shows it');
  assert.deepEqual(answer, { allowed: false, reason: logged[0]!.reason });
  assert.match(logged[0]!.reason, /outside every approved scope \(curl\)/);
  assert.deepEqual(reported, [{ allowed: false, layer: 'scope', reason: logged[0]!.reason }]);
  assert.doesNotMatch(JSON.stringify(reported), /sk-ant-do-not-log|install\.sh/);
});

test('a call that runs answers a plain true, and still reports why', async () => {
  const reported: ApprovalDecision[] = [];
  const policy = createPermissionPolicy({ mode: 'headless', commands: {} });
  const answer = await policy.approve({
    session,
    call: { id: 'call-8', toolName: 'memory.recall', input: {} },
    tool: { name: 'memory.recall', risk: 'safe', async execute() { return null; } },
    risk: 'safe',
    decided: (decision) => reported.push(decision),
  });
  assert.equal(answer, true);
  assert.deepEqual(reported, [{ allowed: true, layer: 'risk', reason: 'memory.recall is safe and runs without approval' }]);
});

test('through the runner, the agent is told why and the dashboard event names the check, never the command', async () => {
  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      return turn === 1
        ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'shell.run', input: { command: COMMAND } } }] }
        : { parts: [{ type: 'text', text: 'done' }] };
    },
  };
  const tools = new ToolRegistry();
  tools.register(shellTool);
  const logged: PermissionDecision[] = [];
  const runner = new AgentRunner({
    provider,
    tools,
    store: new InMemorySessionStore(),
    approvals: createPermissionPolicy({ mode: 'headless', commands: {}, onDecision: (decision) => logged.push(decision) }),
  });
  const events: StratusEvent[] = [];
  runner.bus.subscribe((event) => {
    events.push(event);
  });
  await runner.initialize();
  const finished = await runner.run({ sessionId: 'sess-run', agent: { id: 'ava', name: 'Ava', tools: ['shell.*'] }, userMessage: 'install it' });

  const result = finished.messages.find((message) => message.toolResult?.callId === 'c1')?.toolResult;
  assert.equal(result?.ok, false);
  assert.equal(result?.error, logged[0]!.reason);
  assert.equal(result?.error, 'shell.run was called outside every approved scope (curl) and nobody is available to approve it');

  const decided = events.filter((event) => event.type === 'permission.decided');
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0], {
    type: 'permission.decided',
    sessionId: 'sess-run',
    agentId: 'ava',
    callId: 'c1',
    toolName: 'shell.run',
    risk: 'gated',
    allowed: false,
    layer: 'scope',
    reason: logged[0]!.reason,
  });
  assert.doesNotMatch(JSON.stringify(decided), /sk-ant-do-not-log|install\.sh/);
});
