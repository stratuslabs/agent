import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  PENDING_APPROVAL_METADATA_KEY,
  PluginRegistry,
  readPendingApproval,
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

test('the approval policy is handed the resolved tool and its risk', async () => {
  const seen: Array<{ toolName: string; risk: string; declared: string | undefined }> = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'safe.read',
    risk: 'safe',
    async execute() {
      return { ok: true };
    },
  });
  // No risk declared. A policy must see this as gated, not safe: forgetting
  // to classify a tool should cost a prompt, never an unattended run.
  tools.register({
    name: 'unclassified',
    async execute() {
      return { ok: true };
    },
  });

  const calls = [
    { id: 'call-a', toolName: 'safe.read', input: {} },
    { id: 'call-b', toolName: 'unclassified', input: {} },
    // Nothing registered under this name: it must never reach the policy,
    // since asking a human to approve a tool that does not exist is noise.
    { id: 'call-c', toolName: 'ghost.tool', input: {} },
  ];

  const provider: ModelProvider = {
    name: 'risk-provider',
    async generate() {
      const next = calls.shift();
      if (!next) {
        return { parts: [{ type: 'text', text: 'done' }] };
      }
      return { parts: [{ type: 'tool-call', call: next }] };
    },
  };

  const runner = new AgentRunner({
    provider,
    tools,
    bus: new EventBus(),
    maxTurns: 8,
    approvals: {
      async approve({ call, tool, risk }) {
        seen.push({ toolName: call.toolName, risk, declared: tool.risk });
        return true;
      },
    },
  });

  const session = await runner.run({
    sessionId: 'risk-session',
    agent: { id: 'risk-agent', name: 'Risk Agent' },
    userMessage: 'use the tools',
  });

  assert.equal(session.status, 'completed');
  assert.deepEqual(seen, [
    { toolName: 'safe.read', risk: 'safe', declared: 'safe' },
    { toolName: 'unclassified', risk: 'gated', declared: undefined },
  ]);
});

test('advertised tool descriptors carry the resolved risk', () => {
  const tools = new ToolRegistry();
  tools.register({ name: 'safe.read', risk: 'safe', async execute() { return null; } });
  tools.register({ name: 'unclassified', async execute() { return null; } });

  assert.deepEqual(
    tools.describe().map((descriptor) => [descriptor.name, descriptor.risk]),
    [['safe.read', 'safe'], ['unclassified', 'gated']],
  );
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

  // The blocked call settles with tool.completed too (carrying the failed
  // result): every tool call emits exactly one settling event.
  assert.deepEqual(events, ['tool.called', 'tool.completed', 'tool.denied', 'tool.completed']);
});

test('streaming runners drain every provider.delta before the final provider.response', async () => {
  const order: string[] = [];
  const bus = new EventBus();
  bus.subscribe(async (event: StratusEvent) => {
    if (event.type === 'provider.delta') {
      // A deliberately slow subscriber: draining must still finish before
      // the final response is delivered.
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Narrowed properly: only a tool-call delta carries a name, and
      // thinking/reset deltas carry nothing at all.
      const { delta } = event;
      const label = delta.type === 'text'
        ? delta.text
        : delta.type === 'tool-call' ? delta.toolName : delta.type;
      order.push(`delta:${label}`);
      return;
    }
    if (event.type === 'provider.response') {
      order.push('response');
    }
  });

  const provider: ModelProvider = {
    name: 'streaming-scripted',
    async generate({ onDelta }) {
      assert.ok(onDelta, 'streaming runner must hand providers a delta sink');
      await onDelta({ type: 'text', text: 'Hel' });
      await onDelta({ type: 'text', text: 'lo' });
      await onDelta({ type: 'tool-call', toolName: 'demo.echo' });
      return { parts: [{ type: 'text', text: 'Hello' }] };
    },
  };

  const runner = new AgentRunner({ provider, bus, streaming: true });
  await runner.initialize();
  await runner.run({
    sessionId: 'stream-1',
    agent: { id: 'streamer', name: 'Streamer' },
    userMessage: 'hi',
  });

  assert.deepEqual(order, ['delta:Hel', 'delta:lo', 'delta:demo.echo', 'response']);
});

test('non-streaming runners never hand providers a delta sink', async () => {
  const provider: ModelProvider = {
    name: 'plain',
    async generate({ onDelta }) {
      assert.equal(onDelta, undefined);
      return { parts: [{ type: 'text', text: 'ok' }] };
    },
  };

  const runner = new AgentRunner({ provider });
  await runner.initialize();
  const session = await runner.run({
    sessionId: 'plain-1',
    agent: { id: 'plain', name: 'Plain' },
    userMessage: 'hi',
  });
  assert.equal(session.status, 'completed');
});

test('aborting a run fails the session with a distinguishable reason', async () => {
  const controller = new AbortController();
  const tools = new ToolRegistry();
  tools.register({
    name: 'slow',
    async execute(_input, _session, context) {
      // The tool observes the turn's signal arriving through the executor.
      assert.equal(context?.signal, controller.signal);
      controller.abort();
      return { done: true };
    },
  });

  const provider: ModelProvider = {
    name: 'tool-then-text',
    async generate({ session, signal }) {
      assert.equal(signal, controller.signal, 'provider must receive the turn signal');
      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: 'never reached' }] };
      }
      return {
        parts: [
          { type: 'tool-call', call: { id: 'call-abort', toolName: 'slow', input: {} } },
        ],
      };
    },
  };

  const store = new InMemorySessionStore();
  const runner = new AgentRunner({ provider, tools, store });
  await runner.initialize();

  await assert.rejects(
    () =>
      runner.run({
        sessionId: 'abort-1',
        agent: { id: 'aborter', name: 'Aborter' },
        userMessage: 'go',
        signal: controller.signal,
      }),
    (error: Error) => error.name === 'RunAbortedError',
  );

  const session = await store.get('abort-1');
  assert.equal(session?.status, 'failed');
  assert.equal(session?.lastError, 'Run aborted');
});

test('approval policies receive the turn signal in their context', async () => {
  const controller = new AbortController();
  const tools = new ToolRegistry();
  tools.register({ name: 'gated', async execute() { return null; } });

  let sawSignal: AbortSignal | undefined;
  const provider: ModelProvider = {
    name: 'one-call',
    async generate({ session }) {
      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: 'done' }] };
      }
      return { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'gated', input: {} } }] };
    },
  };

  const runner = new AgentRunner({
    provider,
    tools,
    approvals: {
      async approve({ signal }) {
        sawSignal = signal;
        return true;
      },
    },
  });
  await runner.initialize();
  await runner.run({
    sessionId: 'approval-signal-1',
    agent: { id: 'gatee', name: 'Gatee' },
    userMessage: 'go',
    signal: controller.signal,
  });

  assert.equal(sawSignal, controller.signal);
});

test('resumed input is durable before any provider work begins', async () => {
  const store = new InMemorySessionStore();
  let storedAtGenerate: string[] = [];

  const provider: ModelProvider = {
    name: 'inspector',
    async generate({ session }) {
      const stored = await store.get(session.id);
      storedAtGenerate = (stored?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content);
      if (storedAtGenerate.length > 1) {
        throw new Error('provider crashed mid-turn');
      }
      return { parts: [{ type: 'text', text: 'first reply' }] };
    },
  };

  const runner = new AgentRunner({ provider, store });
  await runner.initialize();
  await runner.run({ sessionId: 'durable-1', agent: { id: 'a', name: 'A' }, userMessage: 'first' });

  await assert.rejects(() => runner.resume({ sessionId: 'durable-1', userMessage: 'second' }));
  // The resumed message was already saved when the provider started —
  // a crash after this point cannot lose accepted input.
  assert.deepEqual(storedAtGenerate, ['first', 'second']);
  const after = await store.get('durable-1');
  assert.deepEqual(after?.messages.filter((m) => m.role === 'user').map((m) => m.content), ['first', 'second']);
});

test('hosted tool calls persist their paired messages to the stored session', async () => {
  const store = new InMemorySessionStore();
  const tools = new ToolRegistry();
  // The call must be durable before the tool runs — a daemon killed
  // mid-tool must never hold a session whose side effects have no
  // recorded attempt (a recovery would replay them).
  let callDurableAtExecution = false;
  tools.register({
    name: 'demo.echo',
    async execute(input) {
      const mid = await store.get('hosted-1');
      callDurableAtExecution = Boolean(mid?.messages.some((m) => m.toolCalls?.[0]?.id === 'hc-1'));
      return { echoed: input };
    },
  });

  const provider: ModelProvider = {
    name: 'unused',
    async generate() {
      return { parts: [{ type: 'text', text: 'unused' }] };
    },
  };

  const runner = new AgentRunner({ provider, tools, store });
  await runner.initialize();

  const session = await store.create({
    id: 'hosted-1',
    agent: { id: 'a', name: 'A' },
    status: 'running',
    messages: [],
  });

  await runner.executeHostedToolCall(session, { id: 'hc-1', toolName: 'demo.echo', input: { text: 'hi' } });

  const stored = await store.get('hosted-1');
  const callMessage = stored?.messages.find((m) => m.toolCalls?.[0]?.id === 'hc-1');
  const resultMessage = stored?.messages.find((m) => m.toolResult?.callId === 'hc-1');
  assert.ok(callMessage, 'the tool call must be recorded in durable history');
  assert.ok(resultMessage, 'the tool result must be recorded in durable history');
  assert.equal(resultMessage.toolResult?.ok, true);
  assert.ok(callDurableAtExecution, 'the tool call must be saved before the tool executes');
});

test('kernel tool activity is saved as it happens, not only at turn end', async () => {
  const inner = new InMemorySessionStore();
  const snapshots: Session[] = [];
  const store = {
    create: (input: Omit<Session, 'createdAt' | 'updatedAt'>) => inner.create(input),
    get: (id: string) => inner.get(id),
    save: async (session: Session) => {
      snapshots.push(JSON.parse(JSON.stringify(session)) as Session);
      await inner.save(session);
    },
  };

  const tools = new ToolRegistry();
  tools.register({
    name: 'remember',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { remembered: true };
    },
  });

  const provider: ModelProvider = {
    name: 'p',
    async generate({ session }) {
      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: 'noted' }] };
      }
      return { parts: [{ type: 'tool-call', call: { id: 'call-9', toolName: 'remember', input: {} } }] };
    },
  };

  const runner = new AgentRunner({ provider, tools, store });
  await runner.run({
    sessionId: 'durable-tools-1',
    agent: { id: 'a', name: 'A' },
    userMessage: 'remember this',
  });

  // A save landed with the call recorded but not yet executed: a daemon
  // killed mid-tool leaves a session that shows the attempt, so a resume
  // does not replay the request and repeat the side effect.
  const callSaved = snapshots.find((snapshot) => {
    const last = snapshot.messages.at(-1);
    return last?.role === 'assistant' && (last.toolCalls?.length ?? 0) > 0;
  });
  assert.ok(callSaved, 'the tool call must be saved before execution');
  assert.equal(callSaved.status, 'running');

  // And a save landed with the result, before the final provider turn.
  const resultSaved = snapshots.find((snapshot) => {
    const last = snapshot.messages.at(-1);
    return last?.role === 'tool' && last.toolResult?.ok === true;
  });
  assert.ok(resultSaved, 'the tool result must be saved right after execution');
  assert.equal(resultSaved.status, 'running');

  assert.equal(snapshots.at(-1)?.status, 'completed');
});

test('rejected tool calls settle with a tool.completed event', async () => {
  const events: StratusEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => {
    events.push(event);
  });

  const provider: ModelProvider = {
    name: 'p',
    async generate({ session }) {
      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: 'fine' }] };
      }
      return { parts: [{ type: 'tool-call', call: { id: 'call-10', toolName: 'ghost', input: {} } }] };
    },
  };

  // Event consumers pairing a response's tool calls with settling events
  // (the gateway's phase-aware watchdog) rely on rejections settling too.
  const runner = new AgentRunner({ provider, bus });
  const session = await runner.run({
    sessionId: 'rejected-1',
    agent: { id: 'a', name: 'A' },
    userMessage: 'call a ghost',
  });

  assert.equal(session.status, 'completed');
  const settled = events.find(
    (event) => event.type === 'tool.completed' && event.result.callId === 'call-10',
  );
  assert.ok(settled, 'a rejected call must emit tool.completed');
  assert.equal(settled.type === 'tool.completed' && settled.result.ok, false);
  assert.match(settled.type === 'tool.completed' ? settled.result.error ?? '' : '', /Tool not found: ghost/);
});

test('resume reconciles a tool call whose result was never recorded', async () => {
  const store = new InMemorySessionStore();
  const now = new Date().toISOString();
  // The durable shape a daemon crash leaves behind: the call was saved
  // before execution, the result never landed.
  await store.create({
    id: 'dangling-1',
    agent: { id: 'a', name: 'A' },
    status: 'running',
    messages: [
      { id: 'u1', role: 'user', content: 'remember it', createdAt: now },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        createdAt: now,
        toolCalls: [{ id: 'c-lost', toolName: 'remember', input: { fact: 'x' } }],
      },
    ],
  });

  let sawInterruptedResult = false;
  const provider: ModelProvider = {
    name: 'p',
    async generate({ session }) {
      // The provider must see a well-formed history: every call answered.
      sawInterruptedResult = session.messages.some(
        (m) => m.role === 'tool' && m.toolResult?.callId === 'c-lost' && m.toolResult.ok === false,
      );
      return { parts: [{ type: 'text', text: 'recovered' }] };
    },
  };

  const runner = new AgentRunner({ provider, store });
  const session = await runner.resume({ sessionId: 'dangling-1', userMessage: 'continue' });

  assert.equal(session.status, 'completed');
  assert.ok(sawInterruptedResult, 'the dangling call must be answered before provider work');
  const callIndex = session.messages.findIndex((m) => m.toolCalls?.[0]?.id === 'c-lost');
  const synthetic = session.messages[callIndex + 1];
  assert.equal(synthetic?.role, 'tool');
  assert.equal(synthetic?.toolResult?.callId, 'c-lost');
  assert.equal(synthetic?.toolResult?.ok, false);
  assert.match(synthetic?.toolResult?.error ?? '', /interrupted/i);
  assert.equal(session.messages.at(-1)?.content, 'recovered');
});

test('every tool call in a response is durable before the first executes', async () => {
  const inner = new InMemorySessionStore();
  const snapshots: Session[] = [];
  const store = {
    create: (input: Omit<Session, 'createdAt' | 'updatedAt'>) => inner.create(input),
    get: (id: string) => inner.get(id),
    save: async (session: Session) => {
      snapshots.push(JSON.parse(JSON.stringify(session)) as Session);
      await inner.save(session);
    },
  };

  const tools = new ToolRegistry();
  let callSetDurableAtFirstExecution = false;
  tools.register({
    name: 'step',
    parameters: { type: 'object', properties: {} },
    async execute() {
      // At the FIRST execution, both calls must already be saved —
      // provider replay state carries the whole response, so a partially
      // persisted call set replays tool uses that reconciliation could
      // never answer.
      if (!callSetDurableAtFirstExecution) {
        const stored = await inner.get('multi-call-1');
        const persistedCallIds = (stored?.messages ?? [])
          .flatMap((m) => m.toolCalls ?? [])
          .map((c) => c.id);
        callSetDurableAtFirstExecution =
          persistedCallIds.includes('mc-1') && persistedCallIds.includes('mc-2');
      }
      return { done: true };
    },
  });

  const provider: ModelProvider = {
    name: 'p',
    async generate({ session }) {
      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: 'both ran' }] };
      }
      return {
        parts: [
          { type: 'tool-call', call: { id: 'mc-1', toolName: 'step', input: {} } },
          { type: 'tool-call', call: { id: 'mc-2', toolName: 'step', input: {} } },
        ],
      };
    },
  };

  const runner = new AgentRunner({ provider, tools, store });
  const session = await runner.run({
    sessionId: 'multi-call-1',
    agent: { id: 'a', name: 'A' },
    userMessage: 'do two things',
  });

  assert.equal(session.status, 'completed');
  assert.ok(callSetDurableAtFirstExecution, 'both calls must be saved before the first runs');
  const resultIds = session.messages.filter((m) => m.role === 'tool').map((m) => m.toolResult?.callId);
  assert.deepEqual(resultIds, ['mc-1', 'mc-2']);
});

test('reconciliation matches repeated tool-call ids by occurrence', async () => {
  const store = new InMemorySessionStore();
  const now = new Date().toISOString();
  // Endpoints that omit ids get a synthesized one per response — the same
  // id twice. The first occurrence was answered; the second is dangling.
  await store.create({
    id: 'dup-id-1',
    agent: { id: 'a', name: 'A' },
    status: 'running',
    messages: [
      { id: 'u1', role: 'user', content: 'step one', createdAt: now },
      {
        id: 'a1', role: 'assistant', content: '', createdAt: now,
        toolCalls: [{ id: 'tool-call-1', toolName: 'step', input: { n: 1 } }],
      },
      {
        id: 't1', role: 'tool', name: 'step', content: '{"ok":true}', createdAt: now,
        toolResult: { callId: 'tool-call-1', toolName: 'step', ok: true, output: { n: 1 } },
      },
      {
        id: 'a2', role: 'assistant', content: '', createdAt: now,
        toolCalls: [{ id: 'tool-call-1', toolName: 'step', input: { n: 2 } }],
      },
    ],
  });

  let historyWellFormed = false;
  const provider: ModelProvider = {
    name: 'p',
    async generate({ session }) {
      // Every call occurrence must be directly followed by a result.
      const dangling = session.messages.some((message, index) => {
        if (message.role !== 'assistant' || !message.toolCalls?.length) {
          return false;
        }
        return session.messages[index + 1]?.role !== 'tool';
      });
      historyWellFormed = !dangling;
      return { parts: [{ type: 'text', text: 'resumed' }] };
    },
  };

  const runner = new AgentRunner({ provider, store });
  const session = await runner.resume({ sessionId: 'dup-id-1', userMessage: 'continue' });

  assert.equal(session.status, 'completed');
  assert.ok(historyWellFormed, 'every call occurrence must be answered before provider work');
  const results = session.messages.filter((m) => m.role === 'tool' && m.toolResult?.callId === 'tool-call-1');
  assert.equal(results.length, 2, 'the second occurrence needs its own result');
  assert.equal(results[0]?.toolResult?.ok, true);
  assert.equal(results[1]?.toolResult?.ok, false);
  assert.match(results[1]?.toolResult?.error ?? '', /interrupted/i);
});

test('the response is durable before provider.response reaches subscribers', async () => {
  const inner = new InMemorySessionStore();
  const order: string[] = [];
  const store = {
    create: (input: Omit<Session, 'createdAt' | 'updatedAt'>) => inner.create(input),
    get: (id: string) => inner.get(id),
    save: async (session: Session) => {
      const last = session.messages.at(-1);
      order.push(`save:${last?.role}:${last?.content ?? ''}`);
      await inner.save(session);
    },
  };

  const bus = new EventBus();
  bus.subscribe((event) => {
    if (event.type === 'provider.response') {
      // A channel could publish the answer the instant this fires — the
      // store must already hold it.
      order.push('response-event');
    }
  });

  const provider: ModelProvider = {
    name: 'p',
    async generate() {
      return { parts: [{ type: 'text', text: 'the answer' }] };
    },
  };

  const runner = new AgentRunner({ provider, store, bus });
  await runner.run({
    sessionId: 'durable-response-1',
    agent: { id: 'a', name: 'A' },
    userMessage: 'ask',
  });

  const saveIndex = order.indexOf('save:assistant:the answer');
  const eventIndex = order.indexOf('response-event');
  assert.ok(saveIndex >= 0, 'the text-only response must be saved');
  assert.ok(eventIndex >= 0, 'provider.response must fire');
  assert.ok(saveIndex < eventIndex, `the save must precede the event: ${JSON.stringify(order)}`);
});

// ---- restart recovery ------------------------------------------------------

/**
 * A three-call response with a gated tool, and a policy that never answers
 * — the shape a daemon dies in when someone was still deciding.
 *
 * `ran` records real executions across BOTH halves of the test, which is
 * how re-execution would show up: a recovered turn that replayed the
 * response would run `first` a second time.
 */
const parkedTurnHarness = () => {
  const ran: string[] = [];
  const store = new InMemorySessionStore();
  const tools = new ToolRegistry();

  for (const name of ['first', 'gated', 'third']) {
    tools.register({
      name,
      // `first` and `third` run unattended; only `gated` reaches a human.
      risk: name === 'gated' ? 'gated' : 'safe',
      async execute() {
        ran.push(name);
        return { name };
      },
    });
  }

  const response = {
    parts: [
      { type: 'tool-call' as const, call: { id: 'c1', toolName: 'first', input: {} } },
      { type: 'tool-call' as const, call: { id: 'c2', toolName: 'gated', input: {} } },
      { type: 'tool-call' as const, call: { id: 'c3', toolName: 'third', input: {} } },
    ],
  };

  let turns = 0;
  const provider: ModelProvider = {
    name: 'fake',
    async generate() {
      turns += 1;
      return turns === 1 ? response : { parts: [{ type: 'text', text: 'done' }] };
    },
  };

  return { ran, store, tools, provider, providerTurns: () => turns };
};

/**
 * Runs until the turn parks, then walks away from it — the honest
 * simulation of `kill -9` mid-approval. The run is deliberately never
 * awaited and never aborted: an abort is a *decision* the policy would
 * observe and the turn would continue from, which is the opposite of a
 * process that stopped existing. The promise simply never settles, which
 * keeps nothing alive.
 *
 * Returns once the checkpoint is durable, since that is exactly what a
 * restarting daemon would find — gated on the record itself, never on a
 * delay.
 */
const parkAndAbandon = async (
  store: InMemorySessionStore,
  tools: ToolRegistry,
  provider: ModelProvider,
  sessionId: string,
): Promise<void> => {
  const dying = new AgentRunner({
    provider,
    tools,
    store,
    approvals: {
      // Waves safe calls through and hangs on the gated one, as a real
      // policy does — the runner asks about every call, so a policy that
      // blocked on all of them would stall before the turn ever parked.
      approve: ({ risk }) => (risk === 'safe'
        ? Promise.resolve(true)
        : new Promise<boolean>(() => {})),
    },
  });
  void dying.run({
    sessionId,
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'go',
  }).catch(() => undefined);

  await new Promise<void>((resolve, reject) => {
    // Bounded so a regression fails this assertion instead of hanging a
    // suite that has no timeout of its own. `polling` stops the loop as
    // well as settling the promise: a setImmediate chain keeps the event
    // loop alive by itself, so one left running past the deadline would
    // hang the suite anyway — the exact failure the bound exists to avoid.
    let polling = true;
    const giveUp = setTimeout(() => {
      polling = false;
      reject(new Error(`${sessionId} never parked`));
    }, 5_000);
    const wait = async (): Promise<void> => {
      if (!polling) {
        return;
      }
      const stored = await store.get(sessionId);
      if (stored && readPendingApproval(stored)) {
        polling = false;
        clearTimeout(giveUp);
        resolve();
        return;
      }
      setImmediate(() => void wait());
    };
    void wait();
  });
};

const pairing = (session: Session): { calls: string[]; results: string[] } => {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of session.messages) {
    for (const call of message.toolCalls ?? []) {
      calls.push(call.id);
    }
    if (message.toolResult) {
      results.push(message.toolResult.callId);
    }
  }
  return { calls, results };
};

test('a turn parked on approval checkpoints what has not run, and clears it on a decision', async () => {
  const { store, tools, provider } = parkedTurnHarness();
  let parked: Session | undefined;

  const runner = new AgentRunner({
    provider,
    tools,
    store,
    approvals: {
      async approve({ session, call }) {
        // Captured only for the gated call. The policy is consulted for
        // every call — it is the policy, not the runner, that waves safe
        // ones through — so the two safe calls around this one would
        // otherwise overwrite the snapshot with an unparked session.
        if (call.toolName === 'gated') {
          // Read from the store rather than the in-memory session: the
          // point is that a separate process could see this.
          parked = await store.get(session.id);
        }
        return true;
      },
    },
  });

  const session = await runner.run({
    sessionId: 'parked-1',
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'go',
  });

  assert.equal(parked?.status, 'pending_approval');
  const record = readPendingApproval(parked!);
  // The call itself, not a reference to it: ids repeat across turns when a
  // provider omits them, so looking one up could find an earlier turn's.
  assert.deepEqual(record?.call, { id: 'c2', toolName: 'gated', input: {} });
  // The queue behind it, so recovery can finish the response.
  assert.deepEqual(record?.remaining.map((call) => call.id), ['c3']);
  assert.ok(record?.parkedAt, 'the wait is timestamped, so its window can be honoured later');

  // And it is gone the moment the decision lands — the record describes a
  // window in which nothing has happened, so it must not outlive one.
  assert.equal(readPendingApproval(session), undefined);
  assert.equal(session.status, 'completed');
});

test('a recovered turn resumes the exact parked call without replaying what already ran', async () => {
  const { ran, store, tools, provider, providerTurns } = parkedTurnHarness();

  // First half: the daemon dies while the approver is deciding.
  await parkAndAbandon(store, tools, provider, 'recover-1');

  assert.deepEqual(ran, ['first'], 'only the call before the parked one ran');

  // Second half: a fresh runner over the same store, as a restarted daemon
  // is. Its approver says yes.
  const revived = new AgentRunner({
    provider,
    tools,
    store,
    approvals: { async approve() { return true; } },
  });
  const recovered = await revived.recoverPendingApproval('recover-1');

  assert.ok(recovered, 'the parked turn was recoverable');
  // Idempotency: `first` ran once, before the crash, and its result was
  // already durable. Replaying the response would show up as a second one.
  assert.deepEqual(ran, ['first', 'gated', 'third']);
  // Pairing: every tool_use in the response has its tool_result, including
  // the call queued behind the parked one.
  const { calls, results } = pairing(recovered);
  assert.deepEqual(calls, ['c1', 'c2', 'c3']);
  assert.deepEqual(results, ['c1', 'c2', 'c3']);
  assert.equal(recovered.status, 'completed');
  assert.equal(readPendingApproval(recovered), undefined);
  // The turn continued to the provider after draining, rather than stopping
  // at the recovered calls.
  assert.ok(providerTurns() >= 2, `expected the loop to continue, saw ${providerTurns()} provider turn(s)`);
});

test('a recovery that denies the parked call still drains the queue behind it', async () => {
  const { ran, store, tools, provider } = parkedTurnHarness();

  await parkAndAbandon(store, tools, provider, 'recover-deny');

  let asked = 0;
  const revived = new AgentRunner({
    provider,
    tools,
    store,
    approvals: {
      async approve() {
        asked += 1;
        return true;
      },
    },
  });
  // What an outlived window does: refuse the parked call without asking.
  const recovered = await revived.recoverPendingApproval('recover-deny', { denyPending: true });

  assert.ok(recovered);
  // The parked call never ran and nobody was asked about it…
  assert.equal(ran.includes('gated'), false);
  // …but the calls behind it were never asked about either, so they still
  // face the policy normally rather than inheriting the refusal.
  assert.deepEqual(ran, ['first', 'third']);
  // Exactly one call reached the policy: `third`. `first` had already run
  // before the crash, and `gated` was refused without asking. (The runner
  // consults the policy for every call it executes — it is the policy that
  // waves `safe` through, not the runner.)
  assert.equal(asked, 1);

  // Pairing survives a denial: the refusal is a tool_result like any other.
  const { calls, results } = pairing(recovered);
  assert.deepEqual(calls, ['c1', 'c2', 'c3']);
  assert.deepEqual(results, ['c1', 'c2', 'c3']);
  const denied = recovered.messages.find((message) => message.toolResult?.callId === 'c2');
  assert.equal(denied?.toolResult?.ok, false);
  assert.match(denied?.toolResult?.error ?? '', /denied by approval policy/);
});

test('a call interrupted mid-execution is not recoverable, only a parked one is', async () => {
  // The distinction the checkpoint exists to draw. A tool that started and
  // died leaves the same trace as one that never started — a call with no
  // result — and only the record can tell them apart. Without it, recovery
  // would re-run side effects that already happened.
  const store = new InMemorySessionStore();
  const now = new Date().toISOString();
  await store.create({
    id: 'mid-flight',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        createdAt: now,
        toolCalls: [{ id: 'c9', toolName: 'gated', input: {} }],
      },
    ],
  });

  const { tools } = parkedTurnHarness();
  const talker: ModelProvider = {
    name: 'fake',
    async generate() {
      return { parts: [{ type: 'text', text: 'ok' }] };
    },
  };
  const runner = new AgentRunner({
    provider: talker,
    tools,
    store,
    approvals: { async approve() { return true; } },
  });

  assert.equal(
    await runner.recoverPendingApproval('mid-flight'),
    undefined,
    'a dangling call with no checkpoint must not be re-entered',
  );

  // resume() still closes it the conservative way, unchanged by any of this.
  const resumed = await runner.resume({ sessionId: 'mid-flight', userMessage: 'still there?' });
  const closed = resumed.messages.find((message) => message.toolResult?.callId === 'c9');
  assert.match(closed?.toolResult?.error ?? '', /may not have run to completion/);
});

test('a parked call is recovered by identity, not by an id an earlier turn also used', async () => {
  // The OpenAI-compatible adapter synthesizes `tool-call-1`, `tool-call-2`
  // per response whenever an endpoint omits ids, so the same id recurs
  // every turn — which is why reconcileInterruptedToolCalls already matches
  // by occurrence. A checkpoint that named its call by id would let
  // recovery find turn one's call and execute it with turn one's input:
  // replaying a side effect while appearing to recover a different one.
  const ran: Array<Record<string, unknown>> = [];
  const store = new InMemorySessionStore();
  const tools = new ToolRegistry();
  tools.register({
    name: 'write',
    risk: 'gated',
    async execute(input) {
      ran.push(input);
      return { ok: true };
    },
  });

  let turns = 0;
  const provider: ModelProvider = {
    name: 'fake',
    async generate() {
      turns += 1;
      // Both turns reuse `tool-call-1`, with different arguments.
      if (turns <= 2) {
        return {
          parts: [{
            type: 'tool-call' as const,
            call: { id: 'tool-call-1', toolName: 'write', input: { target: turns === 1 ? 'first' : 'second' } },
          }],
        };
      }
      return { parts: [{ type: 'text', text: 'done' }] };
    },
  };

  // Turn one approves and runs; turn two parks.
  let approvals = 0;
  const dying = new AgentRunner({
    provider,
    tools,
    store,
    approvals: {
      approve: () => {
        approvals += 1;
        return approvals === 1 ? Promise.resolve(true) : new Promise<boolean>(() => {});
      },
    },
  });
  void dying.run({
    sessionId: 'reused-ids',
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'go',
  }).catch(() => undefined);

  await new Promise<void>((resolve, reject) => {
    let polling = true;
    const giveUp = setTimeout(() => {
      polling = false;
      reject(new Error('never parked'));
    }, 5_000);
    const wait = async (): Promise<void> => {
      if (!polling) {
        return;
      }
      const stored = await store.get('reused-ids');
      if (stored && readPendingApproval(stored)) {
        polling = false;
        clearTimeout(giveUp);
        resolve();
        return;
      }
      setImmediate(() => void wait());
    };
    void wait();
  });

  assert.deepEqual(ran, [{ target: 'first' }], 'only turn one ran before the crash');

  const revived = new AgentRunner({
    provider,
    tools,
    store,
    approvals: { async approve() { return true; } },
  });
  await revived.recoverPendingApproval('reused-ids');

  // The recovered call is turn TWO's, with turn two's input. Resolving the
  // id against the transcript would have re-run `first`.
  assert.deepEqual(ran, [{ target: 'first' }, { target: 'second' }]);
});

test('a hosted tool call is never checkpointed, so a restart fails it cleanly', async () => {
  // 04 excludes the SDK path from the resume-the-exact-call guarantee on
  // purpose: recovery re-enters the KERNEL loop, and it cannot rebuild an
  // SDK inner loop or the handler waiting to consume this result. A
  // checkpoint here would have a restart execute the call and then continue
  // from a state the hosting provider never produced. No checkpoint is the
  // clean failure that doc asks for.
  const store = new InMemorySessionStore();
  const tools = new ToolRegistry();
  tools.register({
    name: 'gated',
    risk: 'gated',
    async execute() {
      return { ok: true };
    },
  });

  let parked: Session | undefined;
  const runner = new AgentRunner({
    provider: { name: 'fake', async generate() { return { parts: [{ type: 'text', text: 'ok' }] }; } },
    tools,
    store,
    approvals: {
      async approve({ session }) {
        parked = await store.get(session.id);
        return true;
      },
    },
  });

  const session = await runner.run({
    sessionId: 'hosted-1',
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'go',
  });
  await runner.executeHostedToolCall(session, { id: 'h1', toolName: 'gated', input: {} });

  // Asked about — the gate still applies on the hosted path…
  assert.ok(parked, 'the policy was consulted');
  // …but nothing durable claims the call is re-enterable.
  assert.equal(readPendingApproval(parked!), undefined);
  assert.notEqual(parked!.status, 'pending_approval');

  const stored = await store.get('hosted-1');
  assert.equal(readPendingApproval(stored!), undefined);
  assert.equal(await runner.recoverPendingApproval('hosted-1'), undefined);
});

test('a recovered call is re-asked with the time it originally parked', async () => {
  // Otherwise every restart hands the request a fresh full window, and a
  // crash-looping daemon keeps one alive forever — the opposite of
  // honouring the deadline it was given.
  const parkedAt = new Date(Date.now() - 3_600_000).toISOString();
  const store = new InMemorySessionStore();
  const tools = new ToolRegistry();
  tools.register({
    name: 'gated',
    risk: 'gated',
    async execute() {
      return { ok: true };
    },
  });

  const now = new Date().toISOString();
  const call = { id: 'c1', toolName: 'gated', input: {} };
  await store.create({
    id: 'carried-park',
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [call] },
    ],
    metadata: { [PENDING_APPROVAL_METADATA_KEY]: { call, remaining: [], parkedAt } },
  });

  const seen: Array<string | undefined> = [];
  const runner = new AgentRunner({
    provider: { name: 'fake', async generate() { return { parts: [{ type: 'text', text: 'ok' }] }; } },
    tools,
    store,
    approvals: {
      async approve(context) {
        seen.push(context.parkedAt);
        return true;
      },
    },
  });

  await runner.recoverPendingApproval('carried-park');

  // The transport is told when the wait began, so it can arm what is left
  // of the window rather than a whole new one.
  assert.deepEqual(seen, [parkedAt]);
});
