import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  PluginRegistry,
  ToolRegistry,
  type Executor,
  type ModelProvider,
  type Session,
  type StratusEvent,
  type Tool,
  type ToolCall,
  type ToolResult,
} from '../src/index.ts';

test('agent runner loops provider -> tool -> provider until no tool calls remain', async () => {
  const events: string[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => {
    events.push(event.type);
  });

  const tools = new ToolRegistry();
  const traces: string[] = [];

  const echoTool: Tool = {
    name: 'echo',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(input) {
      traces.push(`tool:${String(input.text)}`);
      return { echoed: String(input.text).toUpperCase() };
    },
  };

  const provider: ModelProvider = {
    name: 'fake-provider',
    async generate({ session, tools: offeredTools }) {
      traces.push(`provider:${session.messages.at(-1)?.role ?? ''}`);
      assert.equal(offeredTools?.[0]?.name, 'echo');
      assert.equal(offeredTools?.[0]?.parameters?.type, 'object');

      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: 'All set' }] };
      }

      return {
        parts: [
          { type: 'text', text: 'Working on it' },
          {
            type: 'tool-call',
            call: {
              id: 'call-1',
              toolName: 'echo',
              input: { text: 'hello stratus' },
            },
          },
        ],
      };
    },
  };

  const executor: Executor = {
    async execute(call: ToolCall, tool: Tool, session: Session): Promise<ToolResult> {
      traces.push(`executor:${call.toolName}:${session.id}`);
      const output = await tool.execute(call.input, session);
      return { callId: call.id, toolName: call.toolName, ok: true, output };
    },
  };

  tools.register(echoTool);

  const runner = new AgentRunner({ provider, tools, executor, bus });
  await runner.initialize();

  const session = await runner.run({
    sessionId: 'session-1',
    agent: { id: 'agent-1', name: 'Kernel' },
    userMessage: 'Say hi',
  });

  assert.equal(session.status, 'completed');
  assert.deepEqual(traces, [
    'provider:user',
    'executor:echo:session-1',
    'tool:hello stratus',
    'provider:tool',
  ]);
  assert.deepEqual(events, [
    'session.created',
    'session.updated',
    'provider.response',
    'tool.called',
    'tool.completed',
    'provider.response',
    'session.updated',
    'session.completed',
  ]);
  assert.equal(session.messages[1]?.content, 'Working on it');
  assert.deepEqual(session.messages[2]?.toolCalls, [
    { id: 'call-1', toolName: 'echo', input: { text: 'hello stratus' } },
  ]);
  assert.match(session.messages[3]?.content ?? '', /HELLO STRATUS/);
  assert.equal(session.messages[3]?.toolResult?.ok, true);
  assert.equal(session.messages[4]?.content, 'All set');
});

test('plugins can register tools before a run', async () => {
  const tools = new ToolRegistry();
  const plugins = new PluginRegistry();

  plugins.register({
    name: 'register-ping',
    setup(context) {
      context.tools.register({
        name: 'ping',
        async execute() {
          return { pong: true };
        },
      });
    },
  });

  const provider: ModelProvider = {
    name: 'plugin-provider',
    async generate({ session }) {
      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: 'Pinged.' }] };
      }

      return {
        parts: [
          {
            type: 'tool-call',
            call: { id: 'call-2', toolName: 'ping', input: {} },
          },
        ],
      };
    },
  };

  const runner = new AgentRunner({ provider, tools, plugins });
  await runner.initialize();

  const session = await runner.run({
    sessionId: 'session-2',
    agent: { id: 'agent-2', name: 'Plugin Agent' },
    userMessage: 'Run ping',
  });

  assert.equal(session.status, 'completed');
  assert.equal(tools.get('ping')?.name, 'ping');
});

test('denied tool calls are fed back to the provider instead of failing the session', async () => {
  const events: StratusEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => {
    events.push(event);
  });

  const tools = new ToolRegistry();
  let toolRan = false;
  tools.register({
    name: 'guarded',
    async execute() {
      toolRan = true;
      return { ok: true };
    },
  });

  const provider: ModelProvider = {
    name: 'denied-provider',
    async generate({ session }) {
      const last = session.messages.at(-1);
      if (last?.role === 'tool') {
        assert.equal(last.toolResult?.ok, false);
        assert.match(last.toolResult?.error ?? '', /denied by approval policy/);
        return { parts: [{ type: 'text', text: 'Understood, skipping the tool.' }] };
      }

      return {
        parts: [
          { type: 'tool-call', call: { id: 'call-3', toolName: 'guarded', input: {} } },
        ],
      };
    },
  };

  const runner = new AgentRunner({
    provider,
    tools,
    bus,
    approvals: {
      async approve() {
        return false;
      },
    },
  });

  const session = await runner.run({
    sessionId: 'session-3',
    agent: { id: 'agent-3', name: 'Guarded Agent' },
    userMessage: 'Try the guarded tool',
  });

  assert.equal(session.status, 'completed');
  assert.equal(toolRan, false);
  assert.ok(events.some((event) => event.type === 'tool.denied'));
  assert.ok(!events.some((event) => event.type === 'tool.called'));
  assert.equal(session.messages.at(-1)?.content, 'Understood, skipping the tool.');
});

test('unknown tools produce a failure result the provider can react to', async () => {
  const provider: ModelProvider = {
    name: 'missing-tool-provider',
    async generate({ session }) {
      const last = session.messages.at(-1);
      if (last?.role === 'tool') {
        assert.match(last.toolResult?.error ?? '', /Tool not found: nope/);
        return { parts: [{ type: 'text', text: 'That tool does not exist.' }] };
      }

      return {
        parts: [
          { type: 'tool-call', call: { id: 'call-4', toolName: 'nope', input: {} } },
        ],
      };
    },
  };

  const runner = new AgentRunner({ provider });
  const session = await runner.run({
    sessionId: 'session-4',
    agent: { id: 'agent-4', name: 'Curious Agent' },
    userMessage: 'Use a tool that does not exist',
  });

  assert.equal(session.status, 'completed');
  assert.equal(session.messages.at(-1)?.content, 'That tool does not exist.');
});

test('sessions fail when the provider never stops requesting tools', async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'loop',
    async execute() {
      return { again: true };
    },
  });

  let calls = 0;
  const provider: ModelProvider = {
    name: 'looping-provider',
    async generate() {
      calls += 1;
      return {
        parts: [
          { type: 'tool-call', call: { id: `call-${calls}`, toolName: 'loop', input: {} } },
        ],
      };
    },
  };

  const runner = new AgentRunner({ provider, tools, maxTurns: 3 });

  await assert.rejects(
    () => runner.run({
      sessionId: 'session-5',
      agent: { id: 'agent-5', name: 'Loop Agent' },
      userMessage: 'Loop forever',
    }),
    /maximum of 3 provider turns/,
  );

  assert.equal(calls, 3);
  const session = await runner.store.get('session-5');
  assert.equal(session?.status, 'failed');
  assert.match(session?.lastError ?? '', /maximum of 3 provider turns/);
});

test('resume continues an existing session with new user input', async () => {
  const store = new InMemorySessionStore();
  const provider: ModelProvider = {
    name: 'chatty-provider',
    async generate({ session }) {
      const userTurns = session.messages.filter((message) => message.role === 'user').length;
      return { parts: [{ type: 'text', text: `Reply ${userTurns}` }] };
    },
  };

  const runner = new AgentRunner({ provider, store });

  await runner.run({
    sessionId: 'session-6',
    agent: { id: 'agent-6', name: 'Chat Agent' },
    userMessage: 'First message',
  });

  const resumed = await runner.resume({
    sessionId: 'session-6',
    userMessage: 'Second message',
  });

  assert.equal(resumed.status, 'completed');
  const contents = resumed.messages.map((message) => message.content);
  assert.deepEqual(contents, ['First message', 'Reply 1', 'Second message', 'Reply 2']);

  await assert.rejects(
    () => runner.resume({ sessionId: 'missing', userMessage: 'Hello?' }),
    /Session not found: missing/,
  );
});

test('tool allowlists apply to unregistered agents passed directly to run', async () => {
  const tools = new ToolRegistry();
  let toolRan = false;
  tools.register({
    name: 'secret-tool',
    async execute() {
      toolRan = true;
      return { ok: true };
    },
  });

  const provider: ModelProvider = {
    name: 'direct-agent-provider',
    async generate({ session, tools: offered }) {
      assert.equal(offered, undefined, 'unregistered restricted agent should be offered no tools');
      if (session.messages.at(-1)?.role === 'tool') {
        assert.match(session.messages.at(-1)?.toolResult?.error ?? '', /not permitted for agent direct-1/);
        return { parts: [{ type: 'text', text: 'Blocked, as expected.' }] };
      }
      return {
        parts: [
          { type: 'tool-call', call: { id: 'call-5', toolName: 'secret-tool', input: {} } },
        ],
      };
    },
  };

  // No AgentRegistry at all — the allowlist rides on the definition itself.
  const runner = new AgentRunner({ provider, tools });
  const session = await runner.run({
    sessionId: 'session-direct',
    agent: { id: 'direct-1', name: 'Direct Agent', tools: [] },
    userMessage: 'try the secret tool',
  });

  assert.equal(session.status, 'completed');
  assert.equal(toolRan, false);
});

test('credentials are scoped per agent and denied outside the allowlist', async () => {
  const { EnvCredentialResolver, scopeCredentials } = await import('../src/index.ts');

  const resolver = new EnvCredentialResolver({
    SLACK_TOKEN: 'xoxb-secret',
    ADMIN_KEY: 'root-secret',
  });

  const supportAgent = {
    id: 'support',
    name: 'Support',
    credentials: ['SLACK_TOKEN'],
  };

  const scoped = scopeCredentials(supportAgent, resolver);
  assert.equal(await scoped.get('SLACK_TOKEN'), 'xoxb-secret');
  await assert.rejects(() => scoped.get('ADMIN_KEY'), /not allowed to access credential: ADMIN_KEY/);

  const noCredsAgent = { id: 'bare', name: 'Bare' };
  const bare = scopeCredentials(noCredsAgent, resolver);
  await assert.rejects(() => bare.get('SLACK_TOKEN'), /not allowed to access credential/);
});

test('event handler errors are isolated and never fail the run', async () => {
  const captured: unknown[] = [];
  const bus = new EventBus({
    onError: (error) => {
      captured.push(error);
    },
  });
  bus.subscribe(() => {
    throw new Error('subscriber exploded');
  });

  const provider: ModelProvider = {
    name: 'quiet-provider',
    async generate() {
      return { parts: [{ type: 'text', text: 'Done.' }] };
    },
  };

  const runner = new AgentRunner({ provider, bus });
  const session = await runner.run({
    sessionId: 'session-7',
    agent: { id: 'agent-7', name: 'Stable Agent' },
    userMessage: 'Hello',
  });

  assert.equal(session.status, 'completed');
  assert.ok(captured.length > 0);
  assert.match(String(captured[0]), /subscriber exploded/);
});

test('executeHostedToolCall runs a tool with approvals, allowlists, and events', async () => {
  const events: string[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => {
    events.push(event.type);
  });

  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    async execute(input) {
      return { echoed: String(input.text).toUpperCase() };
    },
  });

  const provider: ModelProvider = {
    name: 'unused',
    async generate() {
      return { parts: [{ type: 'text', text: 'unused' }] };
    },
  };

  let deny = false;
  const runner = new AgentRunner({
    provider,
    tools,
    bus,
    approvals: {
      async approve() {
        return !deny;
      },
    },
  });
  await runner.initialize();

  const session: Session = {
    id: 'hosted-1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Approved call: executes and emits tool.called/tool.completed.
  const ok = await runner.executeHostedToolCall(session, { id: 'c1', toolName: 'echo', input: { text: 'hi' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.output, { echoed: 'HI' });

  // Denied call: the approval policy still gates hosted execution.
  deny = true;
  const denied = await runner.executeHostedToolCall(session, { id: 'c2', toolName: 'echo', input: { text: 'no' } });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /denied by approval policy/);

  // Allowlisted agents stay scoped even when the provider drives the loop.
  const scoped: Session = { ...session, agent: { id: 'rex', name: 'Rex', tools: ['other.tool'] } };
  deny = false;
  const blocked = await runner.executeHostedToolCall(scoped, { id: 'c3', toolName: 'echo', input: { text: 'x' } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? '', /not permitted/);

  assert.deepEqual(events, ['tool.called', 'tool.completed', 'tool.denied']);
});
