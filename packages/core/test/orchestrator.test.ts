import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  PluginRegistry,
  ToolRegistry,
  type Executor,
  type ModelProvider,
  type Session,
  type Tool,
  type ToolCall,
  type ToolResult,
} from '../src/index.ts';

test('agent runner completes a basic provider -> tool orchestration flow', async () => {
  const events: string[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => {
    events.push(event.type);
  });

  const tools = new ToolRegistry();
  const traces: string[] = [];

  const echoTool: Tool = {
    name: 'echo',
    async execute(input) {
      traces.push(`tool:${String(input.text)}`);
      return { echoed: String(input.text).toUpperCase() };
    },
  };

  const provider: ModelProvider = {
    name: 'fake-provider',
    async generate({ session }) {
      traces.push(`provider:${session.messages.at(-1)?.content ?? ''}`);
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
          { type: 'text', text: 'Done' },
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
    'provider:Say hi',
    'executor:echo:session-1',
    'tool:hello stratus',
  ]);
  assert.deepEqual(events, [
    'session.created',
    'session.updated',
    'provider.response',
    'tool.called',
    'tool.completed',
    'session.updated',
    'session.completed',
  ]);
  assert.equal(session.messages[1]?.content, 'Working on it');
  assert.equal(session.messages[3]?.content, 'Done');
  assert.match(session.messages[2]?.content ?? '', /HELLO STRATUS/);
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
    async generate() {
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
