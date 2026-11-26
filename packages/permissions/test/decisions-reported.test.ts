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

test('only a person\'s yes to this call names who gave it, for the runner to hand the tool', async () => {
  const notesTool: Tool = { name: 'notes.add', risk: 'gated', async execute() { return null; } };
  const decide = async (policy: ReturnType<typeof createPermissionPolicy>): Promise<{ ran: boolean; reported: ApprovalDecision[] }> => {
    const reported: ApprovalDecision[] = [];
    const answer = await policy.approve({
      session,
      call: { id: 'call-9', toolName: 'notes.add', input: {} },
      tool: notesTool,
      risk: 'gated',
      decided: (decision) => reported.push(decision),
    });
    return { ran: answer === true, reported };
  };

  // A remote answer that names its approver, one that names nobody, and the terminal prompt.
  const named = await decide(createPermissionPolicy({ mode: 'remote', request: async () => ({ answer: 'once', actor: 'U-APPROVER', shownInFull: true }) }));
  assert.equal(named.ran, true);
  assert.deepEqual(named.reported.map((decision) => [decision.layer, decision.approvedBy]), [['approver', 'U-APPROVER']]);
  assert.equal((await decide(createPermissionPolicy({ mode: 'remote', request: async () => ({ answer: 'once', shownInFull: true }) }))).reported.at(-1)?.approvedBy, 'remote');
  assert.equal((await decide(createPermissionPolicy({ mode: 'interactive', ask: async () => 'y' }))).reported.at(-1)?.approvedBy, 'terminal');

  // A yes given on a view that left part of the call out still runs it, but
  // names nobody: a surface that cut the input, or one that never says.
  const cut = await decide(createPermissionPolicy({ mode: 'remote', request: async () => ({ answer: 'once', actor: 'U-APPROVER', shownInFull: false }) }));
  assert.equal(cut.ran, true);
  assert.equal(cut.reported.at(-1)?.approvedBy, undefined);
  const unsaid = await decide(createPermissionPolicy({ mode: 'remote', request: async () => ({ answer: 'once', actor: 'U-APPROVER' }) }));
  assert.equal(unsaid.ran, true);
  assert.equal(unsaid.reported.at(-1)?.approvedBy, undefined);
  assert.equal((await decide(createPermissionPolicy({ mode: 'remote', request: async () => 'once' }))).reported.at(-1)?.approvedBy, undefined);

  // "always" is a yes to this call; the calls its grant covers afterwards are not.
  const granting = createPermissionPolicy({ mode: 'remote', request: async () => ({ answer: 'always', actor: 'U-APPROVER', shownInFull: true }) });
  assert.equal((await decide(granting)).reported.at(-1)?.approvedBy, 'U-APPROVER');
  const covered = await decide(granting);
  assert.equal(covered.ran, true);
  assert.equal(covered.reported.at(-1)?.layer, 'grant');
  assert.equal(covered.reported.at(-1)?.approvedBy, undefined);

  // A person's no, a safe tool, and the open posture's fast path.
  const refused = await decide(createPermissionPolicy({ mode: 'remote', request: async () => ({ answer: 'deny', actor: 'U-APPROVER', shownInFull: true }) }));
  assert.equal(refused.ran, false);
  assert.equal(refused.reported.at(-1)?.approvedBy, undefined);
  const open = await decide(createPermissionPolicy({ mode: 'remote', openFor: () => true, request: async () => ({ answer: 'once', actor: 'U-APPROVER', shownInFull: true }) }));
  assert.equal(open.ran, true);
  assert.ok(open.reported.every((decision) => decision.approvedBy === undefined));
});

test('the terminal prompt names who said yes only when it printed the whole call', async () => {
  const scheduleTool: Tool = { name: 'schedule.every', risk: 'gated', async execute() { return null; } };
  const shellTool: Tool = { name: 'shell.run', risk: 'gated', commandFor: (input) => String(input.command), async execute() { return null; } };
  const approvedByFor = async (tool: Tool, input: Record<string, string>): Promise<{ ran: boolean; approvedBy: string | undefined; asked: string[] }> => {
    const asked: string[] = [];
    const reported: ApprovalDecision[] = [];
    const policy = createPermissionPolicy({ mode: 'interactive', ask: async (question) => { asked.push(question); return 'y'; } });
    const answer = await policy.approve({
      session,
      call: { id: 'call-10', toolName: tool.name, input },
      tool,
      risk: 'gated',
      decided: (decision) => reported.push(decision),
    });
    return { ran: answer === true, approvedBy: reported.at(-1)?.approvedBy, asked };
  };

  const short = await approvedByFor(scheduleTool, { every: '1d', prompt: 'Post the standup summary.' });
  assert.equal(short.ran, true);
  assert.match(short.asked[0] ?? '', /Post the standup summary\./);
  assert.equal(short.approvedBy, 'terminal');

  // A long prompt is capped on screen, so the yes runs the call and names nobody.
  const long = await approvedByFor(scheduleTool, { every: '1d', prompt: `Post the standup summary. ${'Then more. '.repeat(200)}Then send the keys.` });
  assert.equal(long.ran, true);
  assert.doesNotMatch(long.asked[0] ?? '', /send the keys/);
  assert.equal(long.approvedBy, undefined);

  // A shell prompt shows the command, not the rest of the input.
  const shell = await approvedByFor(shellTool, { command: 'ls', cwd: '/tmp' });
  assert.equal(shell.ran, true);
  assert.equal(shell.approvedBy, undefined);
});
