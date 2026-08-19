import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFileMemoryStore,
  unsupportedNodeMessage,
  CLI_VERSION,
  createLogWriter,
  currentLogPosition,
  formatEvent,
  truncateRedirectLogs,
  installService,
  readServiceStatus,
  serviceUnitPath,
  startService,
  stopService,
  uninstallService,
  type ServiceRunner,
  HELP_TEXT,
  parseCommand,
  resolveRuntimeConfig,
  runCli,
  readRecentRecords,
  slackAppManifest,
  tailLog,
} from '../src/index.ts';

const packageDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
// Isolated HOME so tests never read or write the real ~/.stratus.
const tempHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));

// `stratus setup` installs the always-on service when it saves. Tests get a
// stub: the real launchctl/systemctl would touch the developer's machine,
// and `systemctl --user` blocks without a session bus.
const stubServiceRunner = async () => ({ code: 0, stdout: '', stderr: '' });

const createStreams = () => {
  let stdout = '';
  let stderr = '';

  return {
    streams: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } },
    },
    output: {
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    },
  };
};

test('the version the CLI reports is the version it was published as', async () => {
  // CLI_VERSION is a second copy of a number that lives in package.json,
  // and it is the one people see: the setup header draws it and the
  // dashboard serves it from /api/status. A release bumps the manifest;
  // nothing makes it bump the constant, and nothing fails if it does not.
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  assert.equal(
    CLI_VERSION,
    manifest.version,
    'CLI_VERSION drifted from package.json — the CLI would report a version it is not',
  );
});

test('the CLI refuses Node versions below the floor its manifests declare', () => {
  // The failure this replaces is an ERR_UNKNOWN_BUILTIN_MODULE for
  // node:sqlite, thrown from a lazy import well after install, naming
  // neither Node nor the version needed.
  // 23.0 through 23.3 are the interesting ones: newer than the 22.x floor,
  // and still shipping node:sqlite behind --experimental-sqlite, because it
  // was unflagged separately on each line (22.13.0 and 23.4.0).
  for (const version of ['20.11.0', 'v18.20.4', '22.12.0', '22.9.1', '23.0.0', '23.3.0', 'v23.3.9']) {
    const message = unsupportedNodeMessage(version);
    assert.ok(message, `${version} is below the floor`);
    assert.match(message, /needs Node 22\.13 or newer/);
    assert.match(message, /23\.4 or newer on the 23\.x line/);
    assert.match(message, new RegExp(version.replace(/^v/, '').replace(/\./g, '\\.')));
  }

  for (const version of ['22.13.0', '22.14.2', '23.4.0', '23.11.1', '24.1.0', 'v22.13.1']) {
    assert.equal(unsupportedNodeMessage(version), undefined, `${version} is supported`);
  }

  // An unrecognized build string is a bad reason to refuse to run.
  for (const version of ['', 'nightly', 'v-broken']) {
    assert.equal(unsupportedNodeMessage(version), undefined);
  }
});

test('parseCommand accepts positional prompts', () => {
  assert.deepEqual(parseCommand(['run', 'hello', 'demo']), {
    command: 'run',
    prompt: 'hello demo',
    format: 'text',
    events: true,
    approvals: 'always',
  });
});

test('parseCommand can read prompts from stdin', () => {
  assert.deepEqual(parseCommand(['run', '--stdin'], { stdin: 'inspect this tool' }), {
    command: 'run',
    prompt: 'inspect this tool',
    format: 'text',
    events: true,
    approvals: 'always',
  });
});

test('parseCommand accepts real-provider flags', () => {
  assert.deepEqual(parseCommand([
    'run',
    '--provider', 'openai',
    '--model', 'gpt-4.1-mini',
    '--base-url', 'https://example.test/v1',
    '--config', './config.json',
    'hello',
  ]), {
    command: 'run',
    prompt: 'hello',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
    configPath: './config.json',
    format: 'text',
    events: true,
    approvals: 'always',
  });
});

test('parseCommand accepts approvals and max-turns flags', () => {
  assert.deepEqual(parseCommand(['run', '--approvals', 'never', '--max-turns', '3', 'hello']), {
    command: 'run',
    prompt: 'hello',
    format: 'text',
    events: true,
    approvals: 'never',
    maxTurns: 3,
  });

  assert.throws(
    () => parseCommand(['run', '--approvals', 'sometimes', 'hello']),
    /Unsupported approvals mode: sometimes/,
  );
  assert.throws(
    () => parseCommand(['run', '--max-turns', 'zero', 'hello']),
    /Invalid value for --max-turns/,
  );
  assert.throws(
    () => parseCommand(['run', '--approvals', 'ask', '--stdin'], { stdin: 'hello' }),
    /--approvals ask cannot be combined with --stdin/,
  );
});

test('parseCommand accepts dashboard flags', () => {
  assert.deepEqual(parseCommand(['dashboard', '--port', '4123', '--host', '0.0.0.0', '--no-open']), {
    command: 'dashboard',
    port: 4123,
    host: '0.0.0.0',
    openBrowser: false,
  });

  // Absent, not defaulted. A defaulted host cannot be told from an explicit
  // `--host 127.0.0.1`, and the two mean opposite things against a config
  // that binds wider.
  assert.deepEqual(parseCommand(['dashboard']), { command: 'dashboard', openBrowser: true });
  assert.deepEqual(parseCommand(['dashboard', '--host', '127.0.0.1']), {
    command: 'dashboard',
    host: '127.0.0.1',
    openBrowser: true,
  });
});

test('parseCommand accepts the setup command', () => {
  assert.deepEqual(parseCommand(['setup']), { command: 'setup' });
  assert.deepEqual(parseCommand(['setup', '--config', './custom.json']), {
    command: 'setup',
    configPath: './custom.json',
  });
  assert.throws(() => parseCommand(['setup', '--bogus']), /Unknown option: --bogus/);
});

test('parseCommand accepts the agents command and the agent list alias', () => {
  assert.deepEqual(parseCommand(['agents']), { command: 'agents', format: 'text' });
  assert.deepEqual(parseCommand(['agents', '--format', 'json']), { command: 'agents', format: 'json' });
  assert.deepEqual(parseCommand(['agent', 'list']), { command: 'agents', format: 'text' });
  assert.throws(() => parseCommand(['agents', '--format', 'soul']), /Unsupported format: soul/);
  assert.throws(() => parseCommand(['agents', '--bogus']), /Unknown option: --bogus/);
});

test('runCli agents lists souls, the built-in default, and memory counts', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const avaPath = path.join(agentsDir, 'ava.md');
  await writeFile(avaPath, [
    '---',
    'name: Ava',
    'id: ava',
    'provider: anthropic',
    'model: claude-opus-5',
    '---',
    '',
    'You are a sharp, warm generalist assistant.',
    '',
  ].join('\n'));
  await writeFile(path.join(agentsDir, 'rex.md'), [
    '---',
    'name: Rex',
    'id: rex',
    '---',
    '',
    'You research things thoroughly.',
    '',
  ].join('\n'));
  await writeFile(path.join(home, '.stratus', 'memory.jsonl'), [
    JSON.stringify({ id: 'ava:memory:1', agentId: 'ava', content: 'Likes jazz.', createdAt: '2026-01-01T00:00:00.000Z' }),
    // A legacy default-agent fact: it must show up under Stratus.
    JSON.stringify({ id: 'anthropic-agent:memory:1', agentId: 'anthropic-agent', content: 'Prefers short answers.', createdAt: '2026-01-02T00:00:00.000Z' }),
    '',
  ].join('\n'));
  await writeFile(path.join(home, '.stratus', 'config.json'), `${JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5', soul: avaPath })}\n`);

  const text = createStreams();
  const textExit = await runCli({ argv: ['agents'], streams: text.streams, env: { cwd, homeDir: home, processEnv: {} } });
  assert.equal(textExit, 0);
  assert.match(text.output.stdout, /Ava {2}\(default\)/);
  assert.match(text.output.stdout, /runs on {3}anthropic · claude-opus-5/);
  assert.match(text.output.stdout, /Stratus {2}\(built-in\)/);
  assert.match(text.output.stdout, /1 remembered fact\b/);
  // Rex has no soul-pinned provider and follows the active setup.
  assert.match(text.output.stdout, /follows your setup — currently anthropic · claude-opus-5/);

  const json = createStreams();
  const jsonExit = await runCli({ argv: ['agent', 'list', '--format', 'json'], streams: json.streams, env: { cwd, homeDir: home, processEnv: {} } });
  assert.equal(jsonExit, 0);
  const { agents } = JSON.parse(json.output.stdout);
  assert.equal(agents.length, 3);
  assert.deepEqual(agents.map((a: { id: string }) => a.id), ['ava', 'rex', 'stratus']);
  const ava = agents[0];
  assert.equal(ava.default, true);
  assert.equal(ava.provider, 'anthropic');
  assert.equal(ava.memories, 1);
  const stratus = agents[2];
  assert.equal(stratus.builtIn, true);
  assert.equal(stratus.default, false);
  // The legacy anthropic-agent fact is inherited by the built-in Stratus.
  assert.equal(stratus.memories, 1);
  // Every entry carries its resolved backend, pinned or not.
  assert.deepEqual(ava.runsOn, { provider: 'anthropic', model: 'claude-opus-5' });
  assert.deepEqual(stratus.runsOn, { provider: 'anthropic', model: 'claude-opus-5' });
});

test('runCli agents resolves model-only soul pins and survives a bad config dir', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  // A soul that pins a model but not a provider.
  await writeFile(path.join(agentsDir, 'nova.md'), [
    '---',
    'name: Nova',
    'id: nova',
    'model: claude-haiku-4-5',
    '---',
    '',
    'Fast and cheap.',
    '',
  ].join('\n'));
  await writeFile(path.join(home, '.stratus', 'config.json'), `${JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5' })}\n`);

  const { streams, output } = createStreams();
  const exitCode = await runCli({ argv: ['agents'], streams, env: { cwd, homeDir: home, processEnv: {} } });
  assert.equal(exitCode, 0);
  // The soul's own model wins over the config's, exactly as a run would resolve it.
  assert.match(output.stdout, /follows your setup — currently anthropic · claude-haiku-4-5/);
  // The built-in default still shows the config's model.
  assert.match(output.stdout, /currently anthropic · claude-opus-5/);

  // A config that exists but cannot be read (here: a directory) degrades to
  // a warning instead of failing the listing.
  const badHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(badHome, '.stratus', 'config.json'), { recursive: true });
  const bad = createStreams();
  const badExit = await runCli({ argv: ['agents'], streams: bad.streams, env: { cwd, homeDir: badHome, processEnv: {} } });
  assert.equal(badExit, 0);
  assert.match(bad.output.stderr, /Warning: ignoring unreadable config/);
  assert.match(bad.output.stdout, /Stratus {2}\(default, built-in\)/);
});

test('runCli agents on a fresh machine shows only the built-in default', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const { streams, output } = createStreams();
  const exitCode = await runCli({ argv: ['agents'], streams, env: { cwd, homeDir: home, processEnv: {} } });
  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Stratus {2}\(default, built-in\)/);
  assert.match(output.stdout, /currently demo \(offline\)/);
  assert.match(output.stdout, /create your own with: stratus agent new/);
});

test('runCli agent new generates a full identity with name and avatar theme', async () => {
  const named = createStreams();
  const namedExit = await runCli({
    argv: ['agent', 'new', '--name', 'Vera Thorne', '--instructions', 'Be kind.', '--format', 'json'],
    streams: named.streams,
  });

  assert.equal(namedExit, 0);
  const definition = JSON.parse(named.output.stdout);
  assert.equal(definition.name, 'Vera Thorne');
  assert.equal(definition.id, 'vera-thorne');
  assert.equal(definition.instructions, 'Be kind.');
  assert.equal(definition.avatar.seed, 'Vera Thorne');
  assert.equal(definition.avatar.palette.length, 3);

  const generated = createStreams();
  const generatedExit = await runCli({ argv: ['agent', 'new'], streams: generated.streams });

  assert.equal(generatedExit, 0);
  assert.match(generated.output.stdout, /Say hello to [A-Z][a-z]+\./);
  assert.match(generated.output.stdout, /avatar {2}\w+ theme, hue \d+/);

  const bad = createStreams();
  const badExit = await runCli({ argv: ['agent', 'delete'], streams: bad.streams });
  assert.equal(badExit, 1);
  assert.match(bad.output.stderr, /Unknown agent subcommand: delete/);
});

test('runCli prints help text', async () => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({ argv: ['help'], streams });

  assert.equal(exitCode, 0);
  assert.equal(output.stdout, `${HELP_TEXT}\n`);
  assert.equal(output.stderr, '');
});

test('runCli executes the demo tool loop', async () => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({ argv: ['run', '--prompt', 'please use the echo tool'], streams });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Starting Stratus Agent local loop with provider=demo/);
  assert.match(output.stdout, /tool.called demo\.echo/);
  assert.match(output.stdout, /→ tool call demo\.echo/);
  assert.match(output.stdout, /\[tool:demo\.echo\]/);
  assert.match(output.stdout, /"uppercase": "PLEASE USE THE ECHO TOOL"/);
  assert.match(output.stdout, /The demo\.echo tool finished with/);
  assert.equal(output.stderr, '');
});

test('runCli denies tool calls when approvals are set to never', async () => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['run', '--prompt', 'please use the echo tool', '--approvals', 'never'],
    streams,
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /tool.denied demo\.echo/);
  assert.doesNotMatch(output.stdout, /tool.called demo\.echo/);
  assert.match(output.stdout, /The demo\.echo tool did not run/);
  assert.equal(output.stderr, '');
});

test('runCli prompts for approval in ask mode and honors the answer', async () => {
  const approved = createStreams();
  const approvedExit = await runCli({
    argv: ['run', '--prompt', 'please use the echo tool', '--approvals', 'ask'],
    streams: approved.streams,
    env: { approvalInput: Readable.from(['y\n']) },
  });

  assert.equal(approvedExit, 0);
  assert.match(approved.output.stderr, /Approve tool call demo\.echo/);
  assert.doesNotMatch(approved.output.stdout, /Approve tool call/);
  assert.match(approved.output.stdout, /tool.called demo\.echo/);
  assert.match(approved.output.stdout, /"uppercase": "PLEASE USE THE ECHO TOOL"/);

  const denied = createStreams();
  const deniedExit = await runCli({
    argv: ['run', '--prompt', 'please use the echo tool', '--approvals', 'ask'],
    streams: denied.streams,
    env: { approvalInput: Readable.from(['n\n']) },
  });

  assert.equal(deniedExit, 0);
  assert.match(denied.output.stdout, /tool.denied demo\.echo/);
  assert.match(denied.output.stdout, /The demo\.echo tool did not run/);
});

test('runCli keeps stdout parseable when combining json format with ask approvals', async () => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['run', '--prompt', 'please use the echo tool', '--format', 'json', '--approvals', 'ask'],
    streams,
    env: { approvalInput: Readable.from(['y\n']) },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stderr, /Approve tool call demo\.echo/);

  const payload = JSON.parse(output.stdout);
  assert.equal(payload.session.status, 'completed');
  assert.ok(
    payload.session.messages.some(
      (message: { role: string; toolResult?: { ok?: boolean } }) =>
        message.role === 'tool' && message.toolResult?.ok === true,
    ),
  );
});

test('runCli can render machine-readable json output', async () => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['run', '--prompt', 'please use the echo tool', '--format', 'json'],
    streams,
  });

  assert.equal(exitCode, 0);
  assert.equal(output.stderr, '');

  const payload = JSON.parse(output.stdout);
  assert.equal(payload.provider, 'demo');
  assert.equal(payload.session.status, 'completed');
  assert.equal(payload.session.metadata.provider, 'demo');
  assert.equal(payload.session.metadata.executor, 'local-command');
  assert.equal(payload.session.messages[0].content, 'please use the echo tool');
});

test('resolveRuntimeConfig loads openai settings from renamed env vars', async () => {
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'openai',
    format: 'text',
    events: true,
  }, {
    processEnv: {
      OPENAI_API_KEY: 'env-key',
      STRATUS_MODEL: 'gpt-4.1-mini',
      STRATUS_BASE_URL: 'https://example.test/v1',
    },
  });

  assert.deepEqual(runtime, {
    provider: 'openai',
    apiKey: 'env-key',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
  });
});

test('resolveRuntimeConfig still supports legacy env vars', async () => {
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'openai',
    format: 'text',
    events: true,
  }, {
    processEnv: {
      STRATUSCLAW_API_KEY: '',
      STRATUSCLAW_MODEL: 'gpt-4.1-mini',
      STRATUSCLAW_BASE_URL: 'https://example.test/v1',
      STRATUSCLAW_API_KEY_ENV: 'CUSTOM_OPENAI_KEY',
      CUSTOM_OPENAI_KEY: 'legacy-key',
    },
  });

  assert.deepEqual(runtime, {
    provider: 'openai',
    apiKey: 'legacy-key',
    apiKeyEnvVar: 'CUSTOM_OPENAI_KEY',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
  });
});

test('resolveRuntimeConfig loads openai settings from config file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const configPath = path.join(tempDir, 'stratus.config.json');

  await writeFile(configPath, JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
    apiKeyEnv: 'CUSTOM_OPENAI_KEY',
  }, null, 2));

  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    format: 'text',
    events: true,
    configPath,
  }, {
    processEnv: {
      CUSTOM_OPENAI_KEY: 'config-key',
    },
  });

  assert.deepEqual(runtime, {
    provider: 'openai',
    apiKey: 'config-key',
    apiKeyEnvVar: 'CUSTOM_OPENAI_KEY',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
  });
});

test('resolveRuntimeConfig falls back to legacy config filename', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const configPath = path.join(tempDir, 'stratusclaw.config.json');

  await writeFile(configPath, JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKeyEnv: 'CUSTOM_OPENAI_KEY',
  }, null, 2));

  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    format: 'text',
    events: true,
  }, {
    cwd: tempDir,
    homeDir: tempHome,
    processEnv: {
      CUSTOM_OPENAI_KEY: 'config-key',
    },
  });

  assert.deepEqual(runtime, {
    provider: 'openai',
    apiKey: 'config-key',
    apiKeyEnvVar: 'CUSTOM_OPENAI_KEY',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  });
});

test('runCli executes the real provider path with env config', async () => {
  const { streams, output } = createStreams();
  let requestUrl = '';
  let requestBody = '';

  const exitCode = await runCli({
    argv: ['run', '--prompt', 'say hello', '--provider', 'openai'],
    streams,
    env: {
      homeDir: tempHome,
      processEnv: {
        OPENAI_API_KEY: 'test-key',
      },
      fetch: async (url, init) => {
        requestUrl = String(url);
        requestBody = String(init?.body ?? '');

        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Hello from the API path.',
                },
              },
            ],
          }),
        } as Response;
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(requestUrl, 'https://api.openai.com/v1/chat/completions');
  assert.match(requestBody, /"model":"gpt-4.1-mini"/);
  assert.match(output.stdout, /Starting Stratus Agent local loop with provider=openai model=gpt-4.1-mini/);
  assert.match(output.stdout, /\[assistant\] Hello from the API path\./);
  assert.equal(output.stderr, '');
});

test('runCli completes a real-provider tool round trip across two turns', async () => {
  const { streams, output } = createStreams();
  const requestBodies: Array<{ messages: Array<Record<string, unknown>>; tools?: unknown[] }> = [];

  const exitCode = await runCli({
    argv: ['run', '--prompt', 'shout hello', '--provider', 'openai'],
    streams,
    env: {
      homeDir: tempHome,
      processEnv: {
        OPENAI_API_KEY: 'test-key',
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as (typeof requestBodies)[number];
        requestBodies.push(body);

        if (requestBodies.length === 1) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: {
                          name: 'demo_echo',
                          arguments: JSON.stringify({ text: 'hello' }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          } as Response;
        }

        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [{ message: { content: 'The echo tool shouted: HELLO' } }],
          }),
        } as Response;
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(requestBodies.length, 2);

  const firstTools = requestBodies[0]?.tools as Array<{ function?: { name?: string } }>;
  assert.equal(firstTools?.[0]?.function?.name, 'demo_echo');

  const secondMessages = requestBodies[1]?.messages ?? [];
  const assistantToolCall = secondMessages.find((message) => Array.isArray(message.tool_calls));
  const toolResult = secondMessages.find((message) => message.role === 'tool');
  assert.ok(assistantToolCall, 'second request should replay the assistant tool call');
  const replayedCalls = assistantToolCall?.tool_calls as Array<{ function?: { name?: string } }>;
  assert.equal(replayedCalls?.[0]?.function?.name, 'demo_echo');
  assert.equal(toolResult?.tool_call_id, 'call-1');
  assert.match(String(toolResult?.content), /HELLO/);

  assert.match(output.stdout, /tool.called demo\.echo/);
  assert.match(output.stdout, /tool.completed demo\.echo ok=true/);
  assert.match(output.stdout, /\[assistant\] The echo tool shouted: HELLO/);
  assert.equal(output.stderr, '');
});

test('stratus dashboard starts a daemon, mints a one-time link, and opens it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-'));
  const { streams, output } = createStreams();
  let openedUrl = '';

  const exitCode = await runCli({
    // Port 0 keeps the suite off a developer's own daemon.
    argv: ['dashboard', '--port', '0'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      openExternal: async (url) => { openedUrl = url; },
      dashboardAutoShutdownMs: 50,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /No daemon is running/);
  assert.match(output.stdout, /Stratus Agent Dashboard ready at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(output.stdout, /Opened your default browser\./);

  // The whole reason the exchange exists: this command can read the token
  // file and a browser cannot, so it lends its authority for one short trip.
  assert.match(openedUrl, /\/api\/v1\/auth\/session\?ott=/);

  // The daemon it started stops with it, leaving nothing pointing at a dead port.
  await assert.rejects(readFile(path.join(home, '.stratus', 'gateway.json'), 'utf8'));
});

test('an explicit dashboard --host narrows a config that binds wider', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-host-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // A trusted config that opens the API to every interface — reasonable for a
  // box the operator meant to expose.
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    `${JSON.stringify({ provider: 'demo', api: { host: '0.0.0.0' } })}\n`,
  );
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    // And an operator asking, on this one run, for the opposite. A host that
    // happens to equal the built-in default is still something they typed.
    argv: ['dashboard', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      dashboardAutoShutdownMs: 50,
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  // Read from the daemon's own record of where it bound, not from the URL
  // this command printed: the point is the interface, not the text.
  assert.match(output.stdout, /ready at http:\/\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(output.stdout, /0\.0\.0\.0/);
});

test('a daemon that dies before it binds is reported, not left unhandled', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-fail-'));
  const agents = path.join(home, '.stratus', 'agents');
  await mkdir(agents, { recursive: true });
  // Two souls claiming one id refuse the roster, so `runServe` rejects before
  // it publishes anything. That rejection had no handler while the readiness
  // loop waited out its fifteen seconds — an unhandled rejection, which ends
  // the process rather than reaching the message below.
  await writeFile(path.join(agents, 'ava.md'), '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  await writeFile(path.join(agents, 'other.md'), '---\nname: Other\nid: ava\n---\n\nAlso Ava.\n');
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['dashboard', '--port', '0', '--no-open'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, dashboardAutoShutdownMs: 50 },
  });

  assert.equal(exitCode, 1);
  // The daemon's own reason, not a generic timeout: "is control-api
  // installed?" sends someone to check a package that is installed fine.
  assert.match(output.stderr, /the daemon could not start/);
  assert.match(output.stderr, /ava/);
});

test('runCli reports missing prompt errors', async () => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({ argv: ['run'], streams });

  assert.equal(exitCode, 1);
  assert.match(output.stderr, /A prompt is required/);
  assert.match(output.stderr, /Usage:/);
});

test('runCli reports missing api key errors for real providers', async () => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['run', '--prompt', 'hello', '--provider', 'openai'],
    streams,
    env: { processEnv: {}, cwd: tempHome, homeDir: tempHome },
  });

  assert.equal(exitCode, 1);
  assert.match(output.stderr, /Missing API key for provider=openai/);
});

test('runCli reads stdin from an injected stdin stream', async () => {
  const { streams, output } = createStreams();
  const stdinStream = Readable.from(['inspect this tool\n']);
  const exitCode = await runCli({ argv: ['run', '--stdin'], streams, env: { stdinStream } });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /inspect this tool/);
  assert.equal(output.stderr, '');
});

test('source bin script works with piped stdin', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', './src/bin.ts', 'run', '--stdin'], {
    cwd: packageDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.stdin.end('please inspect this tool\n');

  const [exitCode] = (await once(child, 'close')) as [number];

  assert.equal(exitCode, 0);
  assert.match(stdout, /Starting Stratus Agent local loop with provider=demo/);
  assert.match(stdout, /please inspect this tool/);
  assert.equal(stderr, '');
});

test('parseCommand accepts the anthropic provider and soul flag', () => {
  assert.deepEqual(parseCommand(['run', '--provider', 'anthropic', '--soul', './ava.md', 'hello']), {
    command: 'run',
    prompt: 'hello',
    provider: 'anthropic',
    soul: './ava.md',
    format: 'text',
    events: true,
    approvals: 'always',
  });

  assert.throws(() => parseCommand(['run', '--provider', 'claude', 'hello']), /Unsupported provider/);
});

test('resolveRuntimeConfig defaults anthropic to claude-opus-5 and its own key env', async () => {
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'anthropic',
    format: 'text',
    events: true,
  }, {
    cwd: tempHome,
    homeDir: tempHome,
    processEnv: {
      ANTHROPIC_API_KEY: 'env-key',
    },
  });

  assert.deepEqual(runtime, {
    provider: 'anthropic',
    apiKey: 'env-key',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    model: 'claude-opus-5',
  });

  await assert.rejects(
    () => resolveRuntimeConfig({
      command: 'run',
      prompt: 'hello',
      provider: 'anthropic',
      format: 'text',
      events: true,
    }, { processEnv: {}, cwd: tempHome, homeDir: tempHome }),
    /Missing API key for provider=anthropic.*ANTHROPIC_API_KEY/,
  );
});

test('resolveRuntimeConfig reads provider, model, and identity from a soul file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const soulPath = path.join(tempDir, 'ava.md');
  await writeFile(soulPath, `---
name: Ava
provider: anthropic
model: claude-test-model
---
Be warm and concise.
`);

  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    format: 'text',
    events: true,
    soul: soulPath,
  }, {
    cwd: tempDir,
    homeDir: tempHome,
    processEnv: { ANTHROPIC_API_KEY: 'env-key' },
  });

  assert.equal(runtime.provider, 'anthropic');
  assert.equal(runtime.provider === 'anthropic' && runtime.model, 'claude-test-model');
  assert.equal(runtime.soul?.agent.name, 'Ava');
  assert.equal(runtime.soul?.agent.instructions, 'Be warm and concise.');

  // Explicit flags still outrank the soul's provider hint.
  const overridden = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'demo',
    format: 'text',
    events: true,
    soul: soulPath,
  }, {
    cwd: tempDir,
    homeDir: tempHome,
    processEnv: {},
  });

  assert.equal(overridden.provider, 'demo');
  assert.equal(overridden.soul?.agent.name, 'Ava');

  await assert.rejects(
    () => resolveRuntimeConfig({
      command: 'run',
      prompt: 'hello',
      format: 'text',
      events: true,
      soul: path.join(tempDir, 'missing.md'),
    }, { cwd: tempDir, processEnv: {} }),
    /Soul file not found/,
  );
});

test('resolveRuntimeConfig picks up a soul from the config file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  await writeFile(path.join(tempDir, 'scout.md'), 'Report findings, not essays.\n');
  await writeFile(path.join(tempDir, 'stratus.config.json'), JSON.stringify({
    provider: 'demo',
    soul: './scout.md',
  }));

  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    format: 'text',
    events: true,
  }, {
    cwd: tempDir,
    homeDir: tempHome,
    processEnv: {},
  });

  assert.equal(runtime.provider, 'demo');
  assert.equal(runtime.soul?.agent.instructions, 'Report findings, not essays.');
});

test('runCli runs as the soul-defined agent', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const soulPath = path.join(tempDir, 'ava.md');
  await writeFile(soulPath, `---
name: Ava
---
Be warm and concise.
`);

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['run', '--soul', soulPath, '--format', 'json', 'hello'],
    streams,
    env: { cwd: tempDir, homeDir: tempHome, processEnv: {} },
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(output.stdout);
  assert.equal(payload.session.agent.name, 'Ava');
  assert.equal(payload.session.agent.id, 'ava');
  assert.equal(payload.session.agent.instructions, 'Be warm and concise.');

  const text = createStreams();
  await runCli({
    argv: ['run', '--soul', soulPath, 'hello'],
    streams: text.streams,
    env: { cwd: tempDir, homeDir: tempHome, processEnv: {} },
  });
  assert.match(text.output.stdout, /provider=demo as Ava/);
});

test('runCli executes the anthropic provider path with env config', async () => {
  const { streams, output } = createStreams();
  const requestBodies: Array<Record<string, any>> = [];

  const exitCode = await runCli({
    argv: ['run', '--prompt', 'say hello', '--provider', 'anthropic'],
    streams,
    env: {
      homeDir: tempHome,
      processEnv: {
        ANTHROPIC_API_KEY: 'test-key',
      },
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Hello from Claude.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(requestBodies[0]?.model, 'claude-opus-5');
  const tools = requestBodies[0]?.tools as Array<{ name?: string }>;
  assert.equal(tools?.[0]?.name, 'demo_echo');
  assert.match(output.stdout, /Starting Stratus Agent local loop with provider=anthropic model=claude-opus-5/);
  assert.match(output.stdout, /\[assistant\] Hello from Claude\./);
  assert.equal(output.stderr, '');
});

test('runCli agent new renders a ready-to-run soul file', async () => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['agent', 'new', '--name', 'Vera', '--instructions', 'Be kind.', '--format', 'soul'],
    streams,
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /^---\n/);
  assert.match(output.stdout, /name: Vera\n/);
  assert.match(output.stdout, /provider: anthropic\n/);
  assert.match(output.stdout, /model: claude-opus-5\n/);
  assert.match(output.stdout, /Be kind\./);
});

test("resolveRuntimeConfig ignores another provider's config file settings", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  await writeFile(path.join(tempDir, 'stratus.config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
    apiKeyEnv: 'CUSTOM_OPENAI_KEY',
  }));

  // The config file was written for openai; selecting anthropic must not
  // inherit its base URL, model, or key env.
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'anthropic',
    format: 'text',
    events: true,
  }, {
    cwd: tempDir,
    processEnv: {
      ANTHROPIC_API_KEY: 'anthropic-key',
      CUSTOM_OPENAI_KEY: 'openai-key',
    },
  });

  assert.deepEqual(runtime, {
    provider: 'anthropic',
    apiKey: 'anthropic-key',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    model: 'claude-opus-5',
  });
});

test('parseCommand accepts the chat command with run-style flags', () => {
  assert.deepEqual(parseCommand(['chat']), { command: 'chat', events: false, approvals: 'always' });
  assert.deepEqual(parseCommand(['chat', '--provider', 'anthropic', '--model', 'claude-opus-5', '--soul', './ava.md', '--max-turns', '4', '--events']), {
    command: 'chat',
    provider: 'anthropic',
    model: 'claude-opus-5',
    soul: './ava.md',
    maxTurns: 4,
    events: true,
    approvals: 'always',
  });
  assert.throws(() => parseCommand(['chat', '--approvals', 'sometimes']), /Invalid value for --approvals/);
  assert.throws(() => parseCommand(['chat', '--bogus']), /Unknown option: --bogus/);
});

test('runCli chat holds one session across piped turns', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['chat', '--provider', 'demo'],
    streams,
    env: {
      cwd,
      homeDir: home,
      processEnv: {},
      stdinStream: Readable.from(['hello\nplease use the echo tool\n/exit\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /you › hello/);
  assert.match(output.stdout, /Stratus › Demo provider ready\. Prompt received: hello/);
  // Second turn runs a tool inside the same chat.
  assert.match(output.stdout, /· using demo\.echo/);
  assert.match(output.stdout, /PLEASE USE THE ECHO TOOL/);
  // Piped transcripts stay plain — no ANSI styling.
  assert.doesNotMatch(output.stdout, /\[/);
});

test('runCli chat routes approval answers through the chat readline', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['chat', '--provider', 'demo', '--approvals', 'ask'],
    streams,
    env: {
      cwd,
      homeDir: home,
      processEnv: {},
      // The 'y' answers the approval question — it must not become a chat message.
      stdinStream: Readable.from(['please use the echo tool\ny\n/exit\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stderr, /Approve tool call demo\.echo/);
  assert.match(output.stdout, /· using demo\.echo/);
  assert.match(output.stdout, /PLEASE USE THE ECHO TOOL/);
  assert.doesNotMatch(output.stdout, /you › y\b/);

  // EOF before the answer denies instead of hanging.
  const eof = createStreams();
  const eofExit = await runCli({
    argv: ['chat', '--provider', 'demo', '--approvals', 'ask'],
    streams: eof.streams,
    env: {
      cwd,
      homeDir: home,
      processEnv: {},
      stdinStream: Readable.from(['please use the echo tool\n']),
    },
  });
  assert.equal(eofExit, 0);
  assert.match(eof.output.stdout, /· demo\.echo denied/);
});

test('runCli chat resumes the same session so the transcript grows across turns', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const { streams, output } = createStreams();
  const requestMessages: Array<Array<{ role: string; content: unknown }>> = [];

  const exitCode = await runCli({
    argv: ['chat', '--provider', 'anthropic'],
    streams,
    env: {
      cwd,
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'test-key' },
      stdinStream: Readable.from(['my name is Dylan\nwhat is my name?\n/exit\n']),
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        requestMessages.push(body.messages);
        const text = requestMessages.length === 1 ? 'Nice to meet you, Dylan!' : 'You are Dylan.';
        return new Response(JSON.stringify({
          id: `msg_${requestMessages.length}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Stratus › Nice to meet you, Dylan!/);
  assert.match(output.stdout, /Stratus › You are Dylan\./);
  // The second request must carry the whole conversation so far — this is
  // the session-resume plumbing channels will reuse.
  assert.equal(requestMessages.length, 2);
  assert.equal(requestMessages[0]?.length, 1);
  const secondTurn = JSON.stringify(requestMessages[1]);
  assert.match(secondTurn, /my name is Dylan/);
  assert.match(secondTurn, /Nice to meet you, Dylan!/);
  assert.match(secondTurn, /what is my name\?/);
});

test('runCli chat survives a failed turn and keeps the conversation going', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const { streams, output } = createStreams();
  let calls = 0;

  const exitCode = await runCli({
    argv: ['chat', '--provider', 'anthropic'],
    streams,
    env: {
      cwd,
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'test-key' },
      stdinStream: Readable.from(['hi\nhi again\n/exit\n']),
      fetch: (async () => {
        calls += 1;
        if (calls === 1) {
          // 400s are not retried by the SDK, so the first turn fails cleanly.
          return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'boom' } }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          id: 'msg_ok',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Back on track.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stderr, /Error: /);
  assert.match(output.stdout, /that turn failed — the conversation is still here/);
  assert.match(output.stdout, /Stratus › Back on track\./);
});

test('runCli persists agent memory across runs through memory.remember', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const systemPrompts: string[] = [];
  let firstRunCalls = 0;

  const firstRun = await runCli({
    argv: ['run', '--prompt', 'remember that I prefer short answers', '--provider', 'anthropic'],
    streams: createStreams().streams,
    env: {
      cwd: tempDir,
      homeDir: tempHome,
      processEnv: { ANTHROPIC_API_KEY: 'test-key' },
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        systemPrompts.push(String(body.system ?? ''));
        firstRunCalls += 1;
        const content = firstRunCalls === 1
          ? [{
              type: 'tool_use',
              id: 'toolu_mem',
              name: 'memory_remember',
              input: { fact: 'The user prefers short answers.' },
            }]
          : [{ type: 'text', text: 'Noted — short answers from here on.' }];
        return new Response(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content,
          stop_reason: firstRunCalls === 1 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(firstRun, 0);
  const stored = (await readFile(path.join(tempHome, '.stratus', 'memory.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].agentId, 'stratus');
  assert.equal(stored[0].content, 'The user prefers short answers.');

  // A brand-new run — new session, same working directory — sees the memory.
  const secondRun = await runCli({
    argv: ['run', '--prompt', 'hi again', '--provider', 'anthropic'],
    streams: createStreams().streams,
    env: {
      cwd: tempDir,
      homeDir: tempHome,
      processEnv: { ANTHROPIC_API_KEY: 'test-key' },
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        systemPrompts.push(String(body.system ?? ''));
        return new Response(JSON.stringify({
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Hey! Keeping it short.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(secondRun, 0);
  assert.match(systemPrompts.at(-1) ?? '', /The user prefers short answers\./);
});

test('the built-in Stratus agent recalls memories saved under legacy default agent ids', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // Facts remembered before the default agent was renamed to 'stratus'.
  await writeFile(
    path.join(home, '.stratus', 'memory.jsonl'),
    [
      JSON.stringify({ id: 'anthropic-agent:memory:legacy-1', agentId: 'anthropic-agent', content: 'The user is allergic to peanuts.', createdAt: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ id: 'demo-agent:memory:legacy-2', agentId: 'demo-agent', content: 'The user works in UTC+2.', createdAt: '2026-01-02T00:00:00.000Z' }),
      JSON.stringify({ id: 'ava:memory:other-agent', agentId: 'ava', content: 'A souled agent fact that must stay private.', createdAt: '2026-01-03T00:00:00.000Z' }),
      '',
    ].join('\n'),
  );

  let system = '';
  const exitCode = await runCli({
    argv: ['run', '--prompt', 'hi', '--provider', 'anthropic'],
    streams: createStreams().streams,
    env: {
      cwd: tempDir,
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'test-key' },
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        system = String(JSON.parse(String(init?.body ?? '{}')).system ?? '');
        return new Response(JSON.stringify({
          id: 'msg_legacy',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Hello!' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(system, /allergic to peanuts/);
  assert.match(system, /works in UTC\+2/);
  assert.doesNotMatch(system, /must stay private/);
});

test('an unnamed soul keeps the same generated identity across invocations', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const soulPath = path.join(tempDir, 'nameless.md');
  await writeFile(soulPath, 'Always answer in haiku.\n');

  const resolveTwice = () => resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    format: 'text',
    events: true,
    soul: soulPath,
  }, { cwd: tempDir, homeDir: tempHome, processEnv: {} });

  const first = await resolveTwice();
  const second = await resolveTwice();

  // Persisted memory is keyed by agent id, so a soul without a name must
  // resolve to the same generated identity every run.
  assert.ok(first.soul?.agent.id);
  assert.equal(first.soul?.agent.id, second.soul?.agent.id);
  assert.equal(first.soul?.agent.name, second.soul?.agent.name);
});

test('resolveRuntimeConfig treats provider-less config settings as openai-specific', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  await writeFile(path.join(tempDir, 'stratus.config.json'), JSON.stringify({
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
    apiKeyEnv: 'CUSTOM_OPENAI_KEY',
  }));

  // Legacy configs predate the anthropic provider, so their settings must
  // not leak into an anthropic run...
  const anthropicRuntime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'anthropic',
    format: 'text',
    events: true,
  }, {
    cwd: tempDir,
    homeDir: tempHome,
    processEnv: { ANTHROPIC_API_KEY: 'anthropic-key', CUSTOM_OPENAI_KEY: 'openai-key' },
  });

  assert.deepEqual(anthropicRuntime, {
    provider: 'anthropic',
    apiKey: 'anthropic-key',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    model: 'claude-opus-5',
  });

  // ...while still applying to openai runs as before.
  const openaiRuntime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'openai',
    format: 'text',
    events: true,
  }, {
    cwd: tempDir,
    homeDir: tempHome,
    processEnv: { CUSTOM_OPENAI_KEY: 'openai-key' },
  });

  assert.deepEqual(openaiRuntime, {
    provider: 'openai',
    apiKey: 'openai-key',
    apiKeyEnvVar: 'CUSTOM_OPENAI_KEY',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
  });
});

test('concurrent memory appends never clobber each other', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const store = createFileMemoryStore(path.join(tempDir, '.stratus', 'memory.jsonl'));
  const other = createFileMemoryStore(path.join(tempDir, '.stratus', 'memory.jsonl'));

  // Two stores over the same file, appending interleaved — as two CLI runs
  // in the same working directory would.
  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) => store.append('ava', `fact a${i}`)),
    ...Array.from({ length: 5 }, (_, i) => other.append('ava', `fact b${i}`)),
  ]);

  const entries = await store.list('ava');
  assert.equal(entries.length, 10);
  const contents = new Set(entries.map((entry) => entry.content));
  assert.equal(contents.size, 10);
});

test("resolveRuntimeConfig drops a soul's model when its provider is overridden", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const soulPath = path.join(tempDir, 'ava.md');
  await writeFile(soulPath, `---
name: Ava
provider: anthropic
model: claude-opus-5
---
Be warm.
`);

  // The soul's Claude model must not follow an explicit switch to openai.
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'openai',
    format: 'text',
    events: true,
    soul: soulPath,
  }, {
    cwd: tempDir,
    homeDir: tempHome,
    processEnv: { OPENAI_API_KEY: 'openai-key' },
  });

  assert.equal(runtime.provider, 'openai');
  assert.equal(runtime.provider === 'openai' && runtime.model, 'gpt-4.1-mini');
  assert.equal(runtime.soul?.agent.name, 'Ava');
});

test('runCli json output never exposes Claude replay state or thinking text', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const { streams, output } = createStreams();
  let calls = 0;

  const exitCode = await runCli({
    argv: ['run', '--prompt', 'remember that I like jazz', '--provider', 'anthropic', '--format', 'json'],
    streams,
    env: {
      cwd: tempDir,
      homeDir: tempHome,
      processEnv: { ANTHROPIC_API_KEY: 'test-key' },
      fetch: (async () => {
        calls += 1;
        const content = calls === 1
          ? [
              { type: 'thinking', thinking: 'Private reasoning about jazz.', signature: 'sig_cli' },
              { type: 'tool_use', id: 'toolu_jazz', name: 'memory_remember', input: { fact: 'The user likes jazz.' } },
            ]
          : [{ type: 'text', text: 'Noted!' }];
        return new Response(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content,
          stop_reason: calls === 1 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(output.stdout);
  assert.equal(payload.session.status, 'completed');
  // Replay state stays in the stored session, never in user-facing output.
  assert.equal(payload.session.metadata.anthropicRawTurns, undefined);
  assert.doesNotMatch(output.stdout, /Private reasoning/);
  assert.doesNotMatch(output.stdout, /sig_cli/);
  // The rest of the metadata is still there.
  assert.equal(payload.session.metadata.provider, 'anthropic');
});

test('setup signs into Claude with a pasted API key, verifies it, and saves credentials', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '1\n', '2\n', 'sk-ant-test-key\n', '7\n']),
      fetch: (async (url: any, init?: any) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers ?? {}).forEach((value, key) => {
          headers[key] = value;
        });
        requests.push({ url: String(url), headers });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Checking the key against the Anthropic API/);
  assert.match(output.stdout, /✓ Key verified — you are signed in to Anthropic\./);
  assert.equal(requests[0]?.url, 'https://api.anthropic.com/v1/models');
  assert.equal(requests[0]?.headers['x-api-key'], 'sk-ant-test-key');

  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.deepEqual(config, { provider: 'anthropic', model: 'claude-opus-5' });

  const credentialsFile = path.join(home, '.stratus', 'credentials.json');
  const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
  assert.deepEqual(credentials, { anthropic: { type: 'api_key', value: 'sk-ant-test-key' } });
  if (process.platform !== 'win32') {
    const mode = (await stat(credentialsFile)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  assert.match(output.stdout, /signed in with an API key — ready to go/);
});

test('setup stores a Claude subscription setup token', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '1\n', '1\n', 'sk-ant-oat-123\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /claude setup-token/);
  assert.match(output.stdout, /✓ Subscription token saved\./);

  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials, { anthropic: { type: 'oauth_token', value: 'sk-ant-oat-123' } });
  assert.match(output.stdout, /signed in with your Claude subscription — ready to go/);
});

test('setup refuses a rejected API key and saves nothing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '1\n', '2\n', 'bad-key\n', '7\n']),
      fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /✗ Anthropic rejected that key \(HTTP 401\)\. It was NOT saved/);
  assert.match(output.stdout, /NOT signed in yet/);
  await assert.rejects(() => readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
});

test('setup creates an agent whose soul lives in ~/.stratus/agents', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['3\n', '1\n', 'Ava\n', 'Be kind and brief.\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Say hello to Ava\./);

  const soulPath = path.join(home, '.stratus', 'agents', 'ava.md');
  const soul = await readFile(soulPath, 'utf8');
  assert.match(soul, /name: Ava\n/);
  assert.match(soul, /Be kind and brief\./);

  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.equal(config.soul, soulPath);

  // A run from a completely different directory finds the global config and
  // becomes Ava.
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'demo',
    format: 'text',
    events: true,
  }, {
    cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-')),
    homeDir: home,
    processEnv: {},
  });
  assert.equal(runtime.soul?.agent.name, 'Ava');
});

test('setup demo path can test run inline before saving', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '3\n', '6\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Demo selected — no sign-in needed/);
  assert.match(output.stdout, /Running a quick hello/);
  assert.match(output.stdout, /\[assistant\] Demo provider ready/);

  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.deepEqual(config, { provider: 'demo' });
});

test('setup warns when exported env vars override the saved config', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: { STRATUS_PROVIDER: 'openai' },
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '3\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /STRATUS_PROVIDER=openai is exported and takes precedence/);
  assert.match(output.stdout, /stratus run --provider demo "say hello"/);
});

test('setup honors STRATUS_CONFIG and --config for the write target', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const envConfigPath = path.join(tempDir, 'env-config.json');

  const viaEnv = createStreams();
  await runCli({
    argv: ['setup'],
    streams: viaEnv.streams,
    env: {
      cwd: tempDir,
      homeDir: home,
      processEnv: { STRATUS_CONFIG: envConfigPath },
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['7\n']),
    },
  });
  assert.match(viaEnv.output.stdout, /STRATUS_CONFIG is set, so the config will be written to/);
  const envWritten = JSON.parse(await readFile(envConfigPath, 'utf8'));
  assert.deepEqual(envWritten, { provider: 'anthropic', model: 'claude-opus-5' });

  const viaFlag = createStreams();
  await runCli({
    argv: ['setup', '--config', './custom.json'],
    streams: viaFlag.streams,
    env: {
      cwd: tempDir,
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '3\n', '7\n']),
    },
  });
  assert.match(viaFlag.output.stdout, /stratus run --config \.\/custom\.json "say hello"/);
  const flagWritten = JSON.parse(await readFile(path.join(tempDir, 'custom.json'), 'utf8'));
  assert.deepEqual(flagWritten, { provider: 'demo' });
});

test('run uses the stored sign-in from the global config and credentials', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'stored-key' } }),
  );

  const baseCommand = { command: 'run' as const, prompt: 'hello', format: 'text' as const, events: true };

  const runtime = await resolveRuntimeConfig(baseCommand, {
    cwd: elsewhere,
    homeDir: home,
    processEnv: {},
  });
  assert.deepEqual(runtime, { provider: 'anthropic', apiKey: 'stored-key', model: 'claude-opus-5' });

  // A subscription token resolves as authToken instead of apiKey.
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-xyz' } }),
  );
  const subscription = await resolveRuntimeConfig(baseCommand, {
    cwd: elsewhere,
    homeDir: home,
    processEnv: {},
  });
  assert.deepEqual(subscription, { provider: 'anthropic', authToken: 'sk-ant-oat-xyz', model: 'claude-opus-5' });

  // Env keys still outrank the stored sign-in.
  const envWins = await resolveRuntimeConfig(baseCommand, {
    cwd: elsewhere,
    homeDir: home,
    processEnv: { ANTHROPIC_API_KEY: 'env-key' },
  });
  assert.deepEqual(envWins, {
    provider: 'anthropic',
    apiKey: 'env-key',
    // The resolver records which variable won, so diagnostics never guess.
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    model: 'claude-opus-5',
  });
});

test('setup Models menu picks default and fallback from live available models', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();

  const routedFetch = (async (url: any) => {
    const target = String(url);
    if (target.includes('api.anthropic.com')) {
      return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), { status: 200 });
  }) as typeof fetch;

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: routedFetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from([
        '1\n', '1\n', '2\n', 'sk-ant-key\n',      // Providers → Claude → API key
        '1\n', '2\n', 'https://local.test/v1\n', 'sk-openai-key\n', // Providers → OpenAI → custom base URL → key
        '2\n', '1\n', '2\n',                      // Models → default → claude-sonnet-5
        '2\n', '2\n', '3\n',                      // Models → fallback → gpt-4.1-mini
        '6\n',
      ]),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /1\) claude-opus-5 — anthropic/);
  assert.match(output.stdout, /3\) gpt-4\.1-mini — openai/);
  assert.match(output.stdout, /Default model set to claude-sonnet-5 \(anthropic\)\./);
  assert.match(output.stdout, /Fallback model set to gpt-4\.1-mini \(openai\)/);
  assert.match(output.stdout, /default claude-sonnet-5 · fallback gpt-4\.1-mini/);

  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.deepEqual(config, {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    fallbackModel: 'gpt-4.1-mini',
    fallbackProvider: 'openai',
    fallbackBaseUrl: 'https://local.test/v1',
  });

  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials, {
    anthropic: { type: 'api_key', value: 'sk-ant-key' },
    openai: { type: 'api_key', value: 'sk-openai-key', baseUrl: 'https://local.test/v1' },
  });
});

test('resolveRuntimeConfig resolves a fallback model with its own sign-in', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    fallbackModel: 'gpt-4.1-mini',
    fallbackProvider: 'openai',
    fallbackBaseUrl: 'https://local.test/v1',
  }));
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    anthropic: { type: 'api_key', value: 'sk-ant' },
    openai: { type: 'api_key', value: 'sk-openai' },
  }));

  const baseCommand = { command: 'run' as const, prompt: 'hello', format: 'text' as const, events: true };
  const runtime = await resolveRuntimeConfig(baseCommand, { cwd: elsewhere, homeDir: home, processEnv: {} });

  assert.equal(runtime.provider, 'anthropic');
  assert.deepEqual(runtime.provider === 'anthropic' && runtime.fallback, {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://local.test/v1',
    apiKey: 'sk-openai',
  });

  // Environment keys outrank the stored fallback credential, mirroring the
  // primary sign-in precedence.
  const envPreferred = await resolveRuntimeConfig(baseCommand, {
    cwd: elsewhere,
    homeDir: home,
    processEnv: { OPENAI_API_KEY: 'env-openai' },
  });
  assert.equal(
    envPreferred.provider === 'anthropic' && envPreferred.fallback?.apiKey,
    'env-openai',
  );

  // Without a working sign-in for the fallback provider, the fallback is
  // skipped rather than failing the run.
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    anthropic: { type: 'api_key', value: 'sk-ant' },
  }));
  const withoutFallbackAuth = await resolveRuntimeConfig(baseCommand, { cwd: elsewhere, homeDir: home, processEnv: {} });
  assert.equal(withoutFallbackAuth.provider === 'anthropic' && withoutFallbackAuth.fallback, undefined);
});

test('runCli fails over to the fallback model when the default model errors', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  await writeFile(path.join(tempDir, 'stratus.config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    fallbackModel: 'gpt-4.1-mini',
    fallbackProvider: 'openai',
  }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['run', '--prompt', 'say hello'],
    streams,
    env: {
      cwd: tempDir,
      homeDir: tempHome,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-openai' },
      fetch: (async (url: any) => {
        if (String(url).includes('api.anthropic.com')) {
          return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }), { status: 401 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Hello from the fallback model.' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /provider=anthropic model=claude-opus-5 fallback=gpt-4\.1-mini/);
  assert.match(output.stderr, /the default model failed .*falling back to gpt-4\.1-mini/);
  assert.match(output.stdout, /\[assistant\] Hello from the fallback model\./);
});

test('switching the default provider clears settings chosen for the old one', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKeyEnv: 'CUSTOM_OPENAI_KEY',
    baseUrl: 'https://local.test/v1',
  }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '1\n', '2\n', 'sk-ant-key\n', '7\n']),
      fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  // The openai model and apiKeyEnv were provider-bound and must not leak
  // into the anthropic default.
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.model, 'claude-opus-5');
  assert.equal(config.apiKeyEnv, undefined);
  // After the switch, the menu shows the new provider's default model.
  assert.match(output.stdout, /default claude-opus-5 \(default\)/);
});

test('creating an agent never claims an id another soul already declares', async () => {
  const { loadRosterSouls } = await import('@stratusagent/state');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  // A filename is not an id. This soul is `renamed.md` and declares
  // `id: ava`, so `ava.md` being free proves nothing about `ava`.
  const existingPath = path.join(agentsDir, 'renamed.md');
  const existing = '---\nname: Ava\nid: ava\n---\n\nThe original Ava.\n';
  await writeFile(existingPath, existing);

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['3\n', '1\n', 'Ava\n', 'Be kind and brief.\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Say hello to Ava\./);

  // The soul that was already there is untouched — not overwritten, and
  // not left sharing an id.
  assert.equal(await readFile(existingPath, 'utf8'), existing);
  const written = (await readdir(agentsDir)).filter((file) => file !== 'renamed.md');
  assert.equal(written.length, 1, `agents dir held ${JSON.stringify(await readdir(agentsDir))}`);
  assert.match(written[0] ?? '', /^ava-[a-z0-9]+\.md$/);

  // Which is the point: the roster still loads, so the daemon still starts.
  const roster = await loadRosterSouls({ homeDir: home });
  assert.deepEqual(roster.map((entry) => entry.soul.agent.id).sort(), ['ava', written[0]?.replace(/\.md$/, '')]);
});

test('creating an agent never claims the configured soul\'s id', async () => {
  const { loadRosterSouls } = await import('@stratusagent/state');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The configured soul is part of the served roster even though its file
  // is nowhere near the agents directory — and it WINS a same-id contest
  // with a roster file, so a new agent sharing its id is not refused, it
  // is shadowed.
  const configuredPath = path.join(home, 'elsewhere.md');
  await writeFile(configuredPath, '---\nname: Ava\nid: ava\n---\n\nThe configured Ava.\n');
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'demo', soul: configuredPath }),
  );

  const { streams } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['3\n', '1\n', 'Ava\n', 'Be kind and brief.\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  const written = await readdir(path.join(home, '.stratus', 'agents'));
  assert.equal(written.length, 1, `agents dir held ${JSON.stringify(written)}`);
  assert.match(written[0] ?? '', /^ava-[a-z0-9]+\.md$/);

  // Both are dispatchable: the roster one by its own id, the configured
  // one still answering as `ava`.
  const roster = await loadRosterSouls({ homeDir: home });
  assert.deepEqual(roster.map((entry) => entry.soul.agent.id), [written[0]?.replace(/\.md$/, '')]);
});

test('a broken configured soul does not discard the roster\'s claims', async () => {
  const { loadRosterSouls } = await import('@stratusagent/state');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'renamed.md'), '---\nname: Ava\nid: ava\n---\n\nThe original Ava.\n');
  // The configured soul is missing. The daemon tolerates that — it warns
  // and keeps serving the roster — so this command must not treat the
  // roster's claims as unknown just because the other source failed, or
  // it writes the very duplicate that would then refuse the roster.
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'demo', soul: path.join(home, 'gone.md') }),
  );

  const { streams } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['3\n', '1\n', 'Ava\n', 'Be kind and brief.\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  const written = (await readdir(agentsDir)).filter((file) => file !== 'renamed.md');
  assert.deepEqual(written.length, 1, `agents dir held ${JSON.stringify(await readdir(agentsDir))}`);
  assert.match(written[0] ?? '', /^ava-[a-z0-9]+\.md$/);
  // Still loads: the roster the command could read is the roster it used.
  await loadRosterSouls({ homeDir: home });
});

test('creating an agent never claims the reserved built-in id', async () => {
  const { loadRosterSouls } = await import('@stratusagent/state');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));

  const { streams } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['3\n', '1\n', 'Stratus\n', 'Be kind and brief.\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  // A soul claiming `stratus` is skipped at load, so writing one would
  // create an agent that silently never appears on the roster.
  const written = await readdir(path.join(home, '.stratus', 'agents'));
  assert.deepEqual(written.map((file) => file.replace(/\.md$/, '')).filter((id) => id === 'stratus'), []);
  const roster = await loadRosterSouls({ homeDir: home });
  assert.equal(roster.length, 1, `roster was ${JSON.stringify(roster.map((entry) => entry.soul.agent.id))}`);
});

test('switching provider warns when the default soul pins another provider', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const soulPath = path.join(home, '.stratus', 'agents', 'ava.md');
  await mkdir(path.dirname(soulPath), { recursive: true });
  await writeFile(soulPath, `---
name: Ava
provider: anthropic
---
Be warm.
`);
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    soul: soulPath,
  }));

  const { streams, output } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '3\n', '7\n']),
    },
  });

  assert.match(output.stdout, /Ava\) pins provider anthropic in their soul, which outranks this choice/);
});

test('setup saves a key when the endpoint has no /models to verify against', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '2\n', 'https://local.test/v1\n', 'sk-local\n', '7\n']),
      fetch: (async () => new Response('not found', { status: 404 })) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  // 404/405 means the compatible endpoint lacks GET /models — that says
  // nothing about the key, so it is saved and checked on first run.
  assert.match(output.stdout, /did not support a key check \(HTTP 404\)/);
  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials, {
    openai: { type: 'api_key', value: 'sk-local', baseUrl: 'https://local.test/v1' },
  });
});

test('the inline test run uses the same env-over-stored key precedence as real runs', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'stored-key' } }),
  );

  const seenKeys: Array<string | undefined> = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'env-key' },
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['6\n', '7\n']),
      fetch: (async (_url: any, init?: any) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers ?? {}).forEach((value, key) => {
          headers[key] = value;
        });
        seenKeys.push(headers['x-api-key']);
        return new Response(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Hello!' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(seenKeys[0], 'env-key');
});

test('a typed model id resolves to the provider that lists it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async (url: any) => {
        if (String(url).includes('api.anthropic.com')) {
          return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from([
        '1\n', '1\n', '2\n', 'sk-ant-key\n',
        '1\n', '2\n', '\n', 'sk-openai-key\n',
        '2\n', '2\n', 'gpt-4.1-mini\n',   // fallback typed by id — listed under openai
        '6\n',
      ]),
    },
  });

  assert.equal(exitCode, 0);
  // Default provider is anthropic, but the typed id belongs to openai.
  assert.match(output.stdout, /Fallback model set to gpt-4\.1-mini \(openai\)/);
  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.equal(config.fallbackProvider, 'openai');
});

test('stored credentials are never sent to an untrusted project-selected endpoint', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'stored-key' } }),
  );
  // A cloned repository could ship exactly this file.
  await writeFile(path.join(project, 'stratus.config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://evil.test/v1',
  }));

  const baseCommand = { command: 'run' as const, prompt: 'hello', format: 'text' as const, events: true };

  // Auto-discovered config + custom URL: the stored key stays home.
  await assert.rejects(
    () => resolveRuntimeConfig(baseCommand, { cwd: project, homeDir: home, processEnv: {} }),
    /saved sign-in is not sent to it/,
  );

  // An explicitly passed --config is the user's own choice.
  const trusted = await resolveRuntimeConfig(
    { ...baseCommand, configPath: path.join(project, 'stratus.config.json') },
    { cwd: project, homeDir: home, processEnv: {} },
  );
  assert.equal(trusted.provider === 'openai' && trusted.apiKey, 'stored-key');

  // A project config pointing at the provider's default endpoint is harmless.
  await writeFile(path.join(project, 'stratus.config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  }));
  const defaultEndpoint = await resolveRuntimeConfig(baseCommand, { cwd: project, homeDir: home, processEnv: {} });
  assert.equal(defaultEndpoint.provider === 'openai' && defaultEndpoint.apiKey, 'stored-key');

  // The same rule protects fallback endpoints.
  await writeFile(path.join(project, 'stratus.config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-4.1-mini',
    fallbackBaseUrl: 'https://evil.test/v1',
  }));
  const fallbackBlocked = await resolveRuntimeConfig(baseCommand, {
    cwd: project,
    homeDir: home,
    processEnv: { ANTHROPIC_API_KEY: 'env-ant' },
  });
  assert.equal(fallbackBlocked.provider === 'anthropic' && fallbackBlocked.fallback, undefined);
});

test('picking a default model warns when the soul pins a different model', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const soulPath = path.join(home, '.stratus', 'agents', 'ava.md');
  await mkdir(path.dirname(soulPath), { recursive: true });
  await writeFile(soulPath, `---
name: Ava
provider: anthropic
model: claude-opus-5
---
Be warm.
`);
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    soul: soulPath,
  }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant' } }),
  );

  const { streams, output } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async () => new Response(JSON.stringify({
        data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }],
      }), { status: 200 })) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['2\n', '1\n', '2\n', '7\n']),
    },
  });

  assert.match(output.stdout, /Default model set to claude-sonnet-5/);
  assert.match(output.stdout, /Ava\) pins model claude-opus-5 in their soul, which outranks this choice/);
});

test('model discovery uses the same credential a real run would use', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'stored-key' } }),
  );

  const listKeys: Array<string | undefined> = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      // The env key outranks the stored one at run time, so discovery must
      // use it too.
      processEnv: { ANTHROPIC_API_KEY: 'env-key' },
      fetch: (async (url: any, init?: any) => {
        if (String(url).includes('/v1/models')) {
          const headers: Record<string, string> = {};
          new Headers(init?.headers ?? {}).forEach((value, key) => {
            headers[key] = value;
          });
          listKeys.push(headers['x-api-key']);
        }
        return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['2\n', '1\n', '1\n', '7\n']),
    },
  });

  assert.equal(listKeys[0], 'env-key');
});

test('a stored primary key never follows an untrusted same-provider fallback URL', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'stored-key' } }),
  );
  // Default endpoint for the primary (harmless), attacker URL for the
  // fallback of the SAME provider — the primary's stored key must not
  // follow it there.
  await writeFile(path.join(project, 'stratus.config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-4o-mini',
    fallbackBaseUrl: 'https://evil.test/v1',
  }));

  const baseCommand = { command: 'run' as const, prompt: 'hello', format: 'text' as const, events: true };

  const blocked = await resolveRuntimeConfig(baseCommand, { cwd: project, homeDir: home, processEnv: {} });
  assert.equal(blocked.provider === 'openai' && blocked.apiKey, 'stored-key');
  assert.equal(blocked.provider === 'openai' && blocked.fallback, undefined);

  // An env-supplied key is the user's own ambient choice and may follow it.
  const envAllowed = await resolveRuntimeConfig(baseCommand, {
    cwd: project,
    homeDir: home,
    processEnv: { OPENAI_API_KEY: 'env-key' },
  });
  assert.deepEqual(envAllowed.provider === 'openai' && envAllowed.fallback, {
    provider: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: 'https://evil.test/v1',
    apiKey: 'env-key',
  });
});

test('a secondary openai sign-in keeps its endpoint with the credential', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams } = createStreams();

  // Default stays anthropic; openai is signed in as a secondary provider
  // with a custom (local) endpoint.
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async (url: any) => {
        if (String(url).includes('api.anthropic.com')) {
          return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ id: 'local-llama' }] }), { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from([
        '1\n', '1\n', '2\n', 'sk-ant-key\n',
        '1\n', '2\n', 'https://local.test/v1\n', 'sk-local\n',
        '6\n',
      ]),
    },
  });

  assert.equal(exitCode, 0);
  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials.openai, { type: 'api_key', value: 'sk-local', baseUrl: 'https://local.test/v1' });

  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.equal(config.provider, 'anthropic');

  // A later openai run pairs the stored key with ITS endpoint, not
  // api.openai.com.
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'openai',
    format: 'text',
    events: true,
  }, {
    cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-')),
    homeDir: home,
    processEnv: {},
  });
  assert.equal(runtime.provider === 'openai' && runtime.baseUrl, 'https://local.test/v1');
  assert.equal(runtime.provider === 'openai' && runtime.apiKey, 'sk-local');
});

test('a bound stored key cannot be redirected, even to the official endpoint', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'sk-local', baseUrl: 'https://local.test/v1' } }),
  );
  // The official URL passes the "default endpoint is harmless" test, so a
  // project config could otherwise reroute the local-service key to OpenAI.
  await writeFile(path.join(project, 'stratus.config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  }));

  const baseCommand = { command: 'run' as const, prompt: 'hello', format: 'text' as const, events: true };

  const runtime = await resolveRuntimeConfig(baseCommand, { cwd: project, homeDir: home, processEnv: {} });
  assert.equal(runtime.provider === 'openai' && runtime.baseUrl, 'https://local.test/v1');
  assert.equal(runtime.provider === 'openai' && runtime.apiKey, 'sk-local');

  // An explicit flag that disagrees refuses the bound key instead of
  // leaking it.
  await assert.rejects(
    () => resolveRuntimeConfig(
      { ...baseCommand, baseUrl: 'https://other.test/v1' },
      { cwd: project, homeDir: home, processEnv: {} },
    ),
    /bound to https:\/\/local\.test\/v1 and is not sent to/,
  );

  // Fallback keys from the store keep their bound endpoint the same way.
  await writeFile(path.join(project, 'stratus.config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-4.1-mini',
    fallbackBaseUrl: 'https://api.openai.com/v1',
  }));
  const fallbackRuntime = await resolveRuntimeConfig(baseCommand, {
    cwd: project,
    homeDir: home,
    processEnv: { ANTHROPIC_API_KEY: 'env-ant' },
  });
  assert.equal(
    fallbackRuntime.provider === 'anthropic' && fallbackRuntime.fallback?.baseUrl,
    'https://local.test/v1',
  );
});

test('signing into a second provider keeps a STRATUS_API_KEY-powered default', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));

  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      // The generic key makes the anthropic default runnable, so signing
      // into openai must not steal the default.
      processEnv: { STRATUS_API_KEY: 'generic-key' },
      fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '2\n', '\n', 'sk-openai\n', '7\n']),
    },
  });

  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.equal(config.provider, 'anthropic');
});

test('the inline test run fails over on the configured fallback', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-4.1-mini',
  }));
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    anthropic: { type: 'api_key', value: 'sk-ant' },
    openai: { type: 'api_key', value: 'sk-openai' },
  }));

  const { streams, output } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async (url: any) => {
        if (String(url).includes('api.anthropic.com')) {
          return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }), { status: 401 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Fallback says hello.' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['6\n', '7\n']),
    },
  });

  // The primary 401s, but option 4 exercises the same failover a real run
  // would perform instead of reporting a failure.
  assert.match(output.stderr, /falling back to gpt-4\.1-mini/);
  assert.match(output.stdout, /\[assistant\] Fallback says hello\./);
  assert.doesNotMatch(output.stdout, /Test run failed/);
});

test('setup warns when a project config shadows the global file it wrote', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  await writeFile(path.join(project, 'stratus.config.json'), JSON.stringify({ provider: 'demo' }));

  const { streams, output } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '3\n', '7\n']),
    },
  });

  assert.match(output.stdout, /stratus\.config\.json exists and takes precedence over the global config/);
  const globalPath = path.join(home, '.stratus', 'config.json');
  assert.ok(output.stdout.includes(`--config ${globalPath}`));
});

test('model discovery keeps a bound stored key on its own endpoint', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The loaded config points openai at the official URL, but the stored
  // credential belongs to a local proxy.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'sk-local', baseUrl: 'https://local.test/v1' } }),
  );

  const listRequests: Array<{ url: string; bearer?: string }> = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async (url: any, init?: any) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers ?? {}).forEach((value, key) => {
          headers[key] = value;
        });
        // `exactOptionalPropertyTypes` distinguishes "absent" from
        // "present and undefined"; an unauthenticated probe means absent.
        listRequests.push({
          url: String(url),
          ...(headers.authorization ? { bearer: headers.authorization } : {}),
        });
        return new Response(JSON.stringify({ data: [{ id: 'local-llama' }] }), { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['2\n', '1\n', '1\n', '7\n']),
    },
  });

  assert.equal(listRequests[0]?.url, 'https://local.test/v1/models');
  assert.equal(listRequests[0]?.bearer, 'Bearer sk-local');
});

test('discovery never sends the generic STRATUS_API_KEY to a secondary provider', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'sk-openai-own' } }),
  );

  const byHost: Record<string, string | undefined> = {};
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      // The generic key authenticates the anthropic default only.
      processEnv: { STRATUS_API_KEY: 'generic-key' },
      fetch: (async (url: any, init?: any) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers ?? {}).forEach((value, key) => {
          headers[key] = value;
        });
        if (String(url).includes('api.anthropic.com')) {
          byHost.anthropic = headers['x-api-key'];
          return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), { status: 200 });
        }
        byHost.openai = headers.authorization;
        return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['2\n', '1\n', '1\n', '7\n']),
    },
  });

  assert.equal(byHost.anthropic, 'generic-key');
  assert.equal(byHost.openai, 'Bearer sk-openai-own');
});

test('an implicit fallback does not follow a provider override', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // No fallbackProvider: this fallback was written for anthropic.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    fallbackModel: 'claude-sonnet-5',
  }));

  const baseCommand = { command: 'run' as const, prompt: 'hello', format: 'text' as const, events: true };

  // Overriding to openai must not attach the Claude fallback model.
  const overridden = await resolveRuntimeConfig(
    { ...baseCommand, provider: 'openai' },
    { cwd: elsewhere, homeDir: home, processEnv: { OPENAI_API_KEY: 'sk-openai' } },
  );
  assert.equal(overridden.provider === 'openai' && overridden.fallback, undefined);

  // Without an override the implicit fallback still works…
  const normal = await resolveRuntimeConfig(baseCommand, {
    cwd: elsewhere,
    homeDir: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-ant' },
  });
  assert.equal(normal.provider === 'anthropic' && normal.fallback?.model, 'claude-sonnet-5');

  // …and an explicit cross-provider fallback survives the override.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    fallbackModel: 'claude-sonnet-5',
    fallbackProvider: 'anthropic',
  }));
  const explicit = await resolveRuntimeConfig(
    { ...baseCommand, provider: 'openai' },
    { cwd: elsewhere, homeDir: home, processEnv: { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-ant' } },
  );
  assert.deepEqual(explicit.provider === 'openai' && explicit.fallback, {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    apiKey: 'sk-ant',
  });
});

test('anthropic discovery, fallback, and save all honor a configured endpoint', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    baseUrl: 'https://ant-proxy.test',
    fallbackModel: 'claude-sonnet-5',
    fallbackProvider: 'anthropic',
  }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant' } }),
  );

  // Discovery hits the proxy, not api.anthropic.com.
  const listUrls: string[] = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async (url: any) => {
        listUrls.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['2\n', '1\n', '1\n', '7\n']),
    },
  });
  assert.equal(listUrls[0], 'https://ant-proxy.test/v1/models?limit=100');

  // Saving kept the endpoint.
  const saved = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.equal(saved.baseUrl, 'https://ant-proxy.test');

  // The same-provider fallback retries against the proxy too.
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    format: 'text',
    events: true,
  }, { cwd: elsewhere, homeDir: home, processEnv: {} });
  assert.equal(runtime.provider === 'anthropic' && runtime.baseUrl, 'https://ant-proxy.test');
  assert.equal(runtime.provider === 'anthropic' && runtime.fallback?.baseUrl, 'https://ant-proxy.test');
});

test('the model picker hides non-chat models and leads with chat ones', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'sk-openai' } }),
  );

  const { streams, output } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async () => new Response(JSON.stringify({
        data: [
          { id: 'dall-e-3' },
          { id: 'gpt-4.1-mini' },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-1' },
        ],
      }), { status: 200 })) as typeof fetch,
      // Accept the advertised default (empty answer picks entry #1).
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['2\n', '1\n', '\n', '7\n']),
    },
  });

  assert.doesNotMatch(output.stdout, /text-embedding|whisper|dall-e/);
  assert.match(output.stdout, /1\) gpt-4\.1-mini — openai/);
  assert.match(output.stdout, /Default model set to gpt-4\.1-mini \(openai\)\./);
});

test('the inline test run keeps a bound stored key on its own endpoint', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const configPath = path.join(tempDir, 'openai-config.json');
  // The loaded config points at the official URL; the credential is bound
  // to a local proxy.
  await writeFile(configPath, JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  }));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'sk-local', baseUrl: 'https://local.test/v1' } }),
  );

  const chatUrls: string[] = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup', '--config', configPath],
    streams,
    env: {
      cwd: tempDir,
      homeDir: home,
      processEnv: {},
      fetch: (async (url: any) => {
        if (String(url).includes('/chat/completions')) {
          chatUrls.push(String(url));
          return new Response(JSON.stringify({
            choices: [{ message: { content: 'Hello from the proxy.' } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['6\n', '7\n']),
    },
  });

  assert.equal(chatUrls[0], 'https://local.test/v1/chat/completions');
});

test('anthropic keys bind to the endpoint they were verified against', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    baseUrl: 'https://ant-proxy.test',
  }));

  const verifyUrls: string[] = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async (url: any) => {
        verifyUrls.push(String(url));
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '1\n', '2\n', 'sk-proxy\n', '7\n']),
    },
  });

  // Verified against the proxy, and bound to it in the store.
  assert.equal(verifyUrls[0], 'https://ant-proxy.test/v1/models');
  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials.anthropic, {
    type: 'api_key',
    value: 'sk-proxy',
    baseUrl: 'https://ant-proxy.test',
  });

  // A later cross-provider anthropic fallback keeps the proxy endpoint.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    fallbackProvider: 'anthropic',
    fallbackModel: 'claude-sonnet-5',
  }));
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    format: 'text',
    events: true,
  }, { cwd: elsewhere, homeDir: home, processEnv: { OPENAI_API_KEY: 'sk-openai' } });
  assert.equal(runtime.provider === 'openai' && runtime.fallback?.baseUrl, 'https://ant-proxy.test');
});

test('the inline test run honors the STRATUS_API_KEY_ENV selector', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'stored-key' } }),
  );

  const seenKeys: Array<string | undefined> = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      // The selector redirects the effective key to MY_KEY, exactly as a
      // real run would resolve it.
      processEnv: { STRATUS_API_KEY_ENV: 'MY_KEY', MY_KEY: 'selector-key' },
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['6\n', '7\n']),
      fetch: (async (_url: any, init?: any) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers ?? {}).forEach((value, key) => {
          headers[key] = value;
        });
        seenKeys.push(headers['x-api-key']);
        return new Response(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Hello!' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });

  assert.equal(seenKeys[0], 'selector-key');
});

test('a rejected replacement sign-in leaves the previous endpoint untouched', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'old-key' } }),
  );

  const { streams, output } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      // The replacement key for the new endpoint is rejected.
      fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['1\n', '2\n', 'https://new.test/v1\n', 'bad-key\n', '7\n']),
    },
  });

  assert.match(output.stdout, /The endpoint was left unchanged as well\./);
  // The old key keeps its old endpoint — the config must not pair it with
  // the endpoint the rejected sign-in named.
  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
  assert.equal(config.baseUrl, 'https://api.openai.com/v1');
});

test('discovery honors a secondary anthropic credential bound endpoint', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // openai is the default; the anthropic key is bound to a proxy.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'gpt-4.1-mini',
  }));
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    openai: { type: 'api_key', value: 'sk-openai' },
    anthropic: { type: 'api_key', value: 'sk-ant-proxy', baseUrl: 'https://ant-proxy.test' },
  }));

  const anthropicUrls: string[] = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      fetch: (async (url: any) => {
        if (String(url).includes('/v1/models')) {
          anthropicUrls.push(String(url));
          return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), { status: 200 });
      }) as typeof fetch,
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['2\n', '1\n', '1\n', '7\n']),
    },
  });

  assert.equal(anthropicUrls[0], 'https://ant-proxy.test/v1/models?limit=100');
});

test('legacy per-directory memories migrate into the global store on first run', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  // Memories written by a pre-0.2.1 install, in the old per-directory spot.
  await mkdir(path.join(projectDir, '.stratus'), { recursive: true });
  const legacyEntry = {
    id: 'ava:memory:legacy-1',
    agentId: 'demo-agent',
    content: 'The user prefers short answers.',
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(projectDir, '.stratus', 'memory.jsonl'),
    `${JSON.stringify(legacyEntry)}\n`,
  );

  const { streams } = createStreams();
  const exitCode = await runCli({
    argv: ['run', 'hello'],
    streams,
    env: { cwd: projectDir, homeDir: home, processEnv: {} },
  });
  assert.equal(exitCode, 0);

  // The fact now lives in the global store…
  const migrated = (await readFile(path.join(home, '.stratus', 'memory.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].content, 'The user prefers short answers.');

  // …and the legacy file is marked so it can never be imported twice.
  await assert.rejects(() => readFile(path.join(projectDir, '.stratus', 'memory.jsonl'), 'utf8'));
  const kept = await readFile(path.join(projectDir, '.stratus', 'memory.jsonl.migrated'), 'utf8');
  assert.match(kept, /short answers/);

  // A second run from the same directory does not duplicate the entry.
  await runCli({
    argv: ['run', 'hello again'],
    streams: createStreams().streams,
    env: { cwd: projectDir, homeDir: home, processEnv: {} },
  });
  const after = (await readFile(path.join(home, '.stratus', 'memory.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.equal(after.length, 1);
});

test('an interrupted memory migration finishes without duplicating facts', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const entry = {
    id: 'demo-agent:memory:crash-1',
    agentId: 'demo-agent',
    content: 'Half-migrated fact.',
    createdAt: new Date().toISOString(),
  };
  // Simulate a crash between append and rename: the claimed file still
  // exists AND the fact already reached the global store.
  await mkdir(path.join(projectDir, '.stratus'), { recursive: true });
  await writeFile(path.join(projectDir, '.stratus', 'memory.jsonl.migrating'), `${JSON.stringify(entry)}\n`);
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'memory.jsonl'), `${JSON.stringify(entry)}\n`);

  const exitCode = await runCli({
    argv: ['run', 'hello'],
    streams: createStreams().streams,
    env: { cwd: projectDir, homeDir: home, processEnv: {} },
  });
  assert.equal(exitCode, 0);

  // Recovery completed the claim without re-importing the entry…
  const globalLines = (await readFile(path.join(home, '.stratus', 'memory.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.equal(globalLines.length, 1);
  await assert.rejects(() => readFile(path.join(projectDir, '.stratus', 'memory.jsonl.migrating'), 'utf8'));
  await readFile(path.join(projectDir, '.stratus', 'memory.jsonl.migrated'), 'utf8');
});

test('memory reads dedupe by entry id', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stratus-cli-'));
  const store = createFileMemoryStore(path.join(dir, 'memory.jsonl'));
  const entry = await store.append('ava', 'A fact.');
  // Simulate a duplicated line from a historical race.
  const raw = await readFile(path.join(dir, 'memory.jsonl'), 'utf8');
  await writeFile(path.join(dir, 'memory.jsonl'), raw + raw);

  const entries = await store.list('ava');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, entry.id);
});

test('runCli serve starts the gateway, prints a ready line, and drains on shutdown', async () => {
  const serveHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  const code = await runCli({
    argv: ['serve', '--no-events'],
    streams,
    env: {
      homeDir: serveHome,
      cwd: serveHome,
      processEnv: {},
      shutdownSignal: controller.signal,
    },
  });

  assert.equal(code, 0);
  assert.match(output.stdout, /stratusd ready — \d+ agent\(s\)/);
  assert.match(output.stdout, /draining in-flight turns/);
  assert.match(output.stdout, /stratusd stopped/);
});

test('parseCommand parses serve options', () => {
  assert.deepEqual(parseCommand(['serve']), { command: 'serve', events: true });
  assert.deepEqual(parseCommand(['serve', '--no-events', '--idle-timeout', '30', '--config', './x.json']), {
    command: 'serve',
    events: false,
    idleTimeoutMs: 30000,
    configPath: './x.json',
  });
  assert.throws(() => parseCommand(['serve', '--idle-timeout', '-2']), /Invalid value for --idle-timeout/);
  assert.deepEqual(parseCommand(['serve', '--approvals', 'remote']), {
    command: 'serve',
    events: true,
    approvals: 'remote',
  });
  // `ask` is a run/chat mode: there is no terminal behind a service
  // manager, so accepting it here would promise a prompt nobody can answer.
  assert.throws(() => parseCommand(['serve', '--approvals', 'ask']), /Use headless or remote/);
});

test('serve in remote mode says who can actually approve', async () => {
  const serveHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-approvals-'));
  await mkdir(path.join(serveHome, '.stratus'), { recursive: true });
  await writeFile(
    path.join(serveHome, '.stratus', 'config.json'),
    JSON.stringify({ approvals: { mode: 'remote', agents: { ava: { slackApprovers: ['U-DYLAN'] } } } }),
  );
  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  const code = await runCli({
    argv: ['serve', '--no-events'],
    streams,
    env: { homeDir: serveHome, cwd: serveHome, processEnv: {}, shutdownSignal: controller.signal },
  });

  assert.equal(code, 0);
  // A daemon configured for remote with no channel running is the failure
  // mode worth surfacing at startup rather than at 3am: nothing renders the
  // request, so the turn hangs for the whole timeout before being denied,
  // and the config looks perfectly fine while it happens.
  assert.match(output.stdout, /approvals: remote/);
  assert.match(output.stdout, /no channel is running to ask through/);
});

test('serve names the agents no channel can ask for', async () => {
  const serveHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-unreachable-'));
  await mkdir(path.join(serveHome, '.stratus'), { recursive: true });
  await writeFile(
    path.join(serveHome, '.stratus', 'config.json'),
    JSON.stringify({ approvals: { mode: 'remote' } }),
  );
  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  const code = await runCli({
    argv: ['serve', '--no-events'],
    streams,
    env: { homeDir: serveHome, cwd: serveHome, processEnv: {}, shutdownSignal: controller.signal },
  });

  assert.equal(code, 0);
  // The quietest failure this feature has: an agent no channel serves parks
  // its gated calls with nobody rendering them, and only discovers it after
  // the full timeout. No adapter can detect this alone — a request is a
  // broadcast, and none of them knows whether another is about to answer —
  // so the daemon reports it where the roster and the channels are both in
  // view.
  assert.match(output.stderr, /no channel can ask for /);
  assert.match(output.stderr, /wait out the \napproval timeout|wait out the approval timeout/);
});

test('serve keeps refusing gated calls when the approvals config cannot be read', async () => {
  const serveHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-badconfig-'));
  await mkdir(path.join(serveHome, '.stratus'), { recursive: true });
  await writeFile(path.join(serveHome, '.stratus', 'config.json'), '{ not json');
  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  const code = await runCli({
    argv: ['serve', '--no-events'],
    streams,
    env: { homeDir: serveHome, cwd: serveHome, processEnv: {}, shutdownSignal: controller.signal },
  });

  // Degrades to headless with a warning rather than taking the fleet down
  // over a policy block that may not even be present — and never to
  // "approve everything", which is the only outcome that would be unsafe.
  assert.equal(code, 0);
  assert.match(output.stderr, /ignoring the approvals config/);
  assert.doesNotMatch(output.stdout, /approvals: remote/);
});

test('optional channel packages are never hard dependencies of the CLI', async () => {
  // Installing the CLI must not drag in a transport nobody asked for: the
  // Slack SDKs alone are ~9 MB. Channel packages are optional peers —
  // present as devDependencies so the workspace builds and tests, absent
  // from what consumers install.
  const { readFile } = await import('node:fs/promises');
  const here = path.dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  const optionalChannels = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
    .filter((name) => name.startsWith('@stratusagent/channel-'));
  assert.ok(optionalChannels.length > 0, 'expected at least one channel package to be declared');

  for (const name of optionalChannels) {
    assert.ok(!manifest.dependencies?.[name], `${name} must not be a hard dependency of the CLI`);
    assert.ok(manifest.peerDependencies?.[name], `${name} must be declared as a peer dependency`);
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${name} must be an OPTIONAL peer`);
    assert.ok(manifest.devDependencies?.[name], `${name} must stay a devDependency so the workspace builds`);
  }
});

test('setup connects an agent to Slack without touching any file by hand', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\n---\n\nYou are Ava.\n');

  const { streams, output } = createStreams();
  const slackCalls: Array<{ url: string; auth: string }> = [];

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      // Channels → Ava (2; the built-in Stratus agent is 1) → paste both
      // tokens → Back → Save & finish
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '2\n', 'xapp-tok\n', 'xoxb-tok\n', '3\n', '7\n']),
      fetch: (async (url: any, init?: any) => {
        slackCalls.push({
          url: String(url),
          auth: new Headers(init?.headers ?? {}).get('authorization') ?? '',
        });
        if (String(url).endsWith('/auth.test')) {
          return new Response(JSON.stringify({ ok: true, user_id: 'B123', team: 'Acme', team_id: 'T1' }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, url: 'wss://slack' }), { status: 200 });
      }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  // Both tokens are verified against Slack before anything is stored.
  assert.deepEqual(slackCalls.map((c) => c.url.replace('https://slack.com/api/', '')), ['auth.test', 'apps.connections.open']);
  assert.equal(slackCalls[0]?.auth, 'Bearer xoxb-tok');
  assert.equal(slackCalls[1]?.auth, 'Bearer xapp-tok');
  assert.match(output.stdout, /✓ Verified — Ava is connected to Slack in Acme \(bot B123\)\./);
  // The manifest is printed for pasting, so app creation needs no file hunt.
  assert.match(output.stdout, /"always_online": true/);
  assert.match(output.stdout, /app_mentions:read/);

  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials.channels, { slack: { ava: { appToken: 'xapp-tok', botToken: 'xoxb-tok' } } });
});

test('setup refuses to store Slack tokens the API rejects', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\n---\n\nYou are Ava.\n');

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '2\n', 'xapp-tok\n', 'xoxb-bad\n', '3\n', '7\n']),
      // Slack answers 200 with ok:false for a bad token.
      fetch: (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 })) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /✗ Slack rejected the bot token \(invalid_auth\)\. Nothing was saved/);
  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8').catch(() => '{}'));
  assert.equal(credentials.channels, undefined);
});

test('setup rejects malformed Slack tokens before calling the API', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\n---\n\nYou are Ava.\n');

  const { streams, output } = createStreams();
  let called = 0;
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '2\n', 'xoxb-wrong-kind\n', '3\n', '7\n']),
      fetch: (async () => { called += 1; return new Response('{}', { status: 200 }); }) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /does not look like an app-level token/);
  assert.equal(called, 0, 'a malformed token must not reach Slack');
});

test('setup disconnects an agent from Slack', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\n---\n\nYou are Ava.\n');
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      anthropic: { type: 'api_key', value: 'sk-keep-me' },
      channels: { slack: { ava: { appToken: 'xapp-old', botToken: 'xoxb-old' } } },
    }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      // Channels → Ava (connected) → Disconnect → Back → Save & finish
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '2\n', '2\n', '3\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Ava is no longer connected to Slack/);
  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials.channels, { slack: {} });
  // Disconnecting a channel must never disturb the provider sign-in.
  assert.deepEqual(credentials.anthropic, { type: 'api_key', value: 'sk-keep-me' });
});

test('the setup manifest matches the one shipped by the Slack package', async () => {
  // Setup generates the manifest itself so it works before the optional
  // channel package is installed; this pins the two copies together.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const shipped = JSON.parse(await readFile(
    path.join(here, '..', '..', 'channel-slack', 'manifest', 'stratus-agent.manifest.json'),
    'utf8',
  ));
  const generated = JSON.parse(slackAppManifest('NAME'));
  assert.deepEqual(generated, shipped);
});

test('the Channels menu offers a default soul that lives outside the roster', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  // `stratus setup` can point the default soul at a file anywhere; the
  // gateway registers it, so Channels must offer it too.
  const soulPath = path.join(project, 'nova.md');
  await writeFile(soulPath, '---\nname: Nova\n---\n\nYou are Nova.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'demo', soul: soulPath }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      processEnv: {},
      // Channels → Nova → tokens → Back → Save & finish
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '1\n', 'xapp-t\n', 'xoxb-t\n', '3\n', '7\n']),
      fetch: (async (url: any) => new Response(JSON.stringify(
        String(url).endsWith('/auth.test')
          ? { ok: true, user_id: 'B9', team: 'Acme', team_id: 'T9' }
          : { ok: true, url: 'wss://x' },
      ), { status: 200 })) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Nova \(nova\)/);
  assert.match(output.stdout, /✓ Verified — Nova is connected to Slack in Acme/);
  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials.channels, { slack: { nova: { appToken: 'xapp-t', botToken: 'xoxb-t' } } });
});

test('a configured soul outranks a same-id roster file in the Channels menu', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  // Same explicit id, two files. The gateway's defaultAgentId replaces the
  // roster source with the configured soul, so Slack dispatches to Nova —
  // offering "Ava" here would name an app after the wrong agent.
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\nid: shared\n---\n\nYou are Ava.\n');
  const soulPath = path.join(project, 'nova.md');
  await writeFile(soulPath, '---\nname: Nova\nid: shared\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'demo', soul: soulPath }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '3\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Nova \(shared\)/);
  assert.doesNotMatch(output.stdout, /Ava \(shared\)/);
});

test('setup suggests serve with the same --config it was run with', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\n---\n\nYou are Ava.\n');

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup', '--config', './custom.json'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '2\n', 'xapp-t\n', 'xoxb-t\n', '3\n', '7\n']),
      fetch: (async (url: any) => new Response(JSON.stringify(
        String(url).endsWith('/auth.test')
          ? { ok: true, user_id: 'B1', team: 'Acme', team_id: 'T1' }
          : { ok: true, url: 'wss://x' },
      ), { status: 200 })) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  // A bare `stratus serve` would read a different config — and therefore a
  // different roster — so the stored Slack app would be skipped.
  assert.match(output.stdout, /run `stratus serve --config \.\/custom\.json` to bring them online/);
});

test('the Channels menu refuses a roster with a duplicate id instead of picking a winner', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  // Two files, one id. Offering either would name a Slack app for an
  // ambiguous agent — credentials are keyed by the shared id, so whichever
  // file loses the sort silently answers with the winner's tokens.
  await writeFile(path.join(agentsDir, 'a-first.md'), '---\nname: First\nid: twin\n---\n\nYou are First.\n');
  await writeFile(path.join(agentsDir, 'b-second.md'), '---\nname: Second\nid: twin\n---\n\nYou are Second.\n');

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '3\n', '7\n']),
    },
  });

  // Setup still runs — providers and sign-ins are configurable regardless
  // — but neither twin is offered a Slack app, and the reason names both
  // files so it can actually be fixed.
  assert.equal(exitCode, 0);
  assert.doesNotMatch(output.stdout, /First \(twin\)/);
  assert.doesNotMatch(output.stdout, /Second \(twin\)/);
  assert.match(output.stderr, /Two soul files declare the agent id twin/);
  assert.match(output.stderr, /a-first\.md/);
  assert.match(output.stderr, /b-second\.md/);
});

test('the Channels menu follows STRATUS_SOUL over the configured soul', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  const configured = path.join(project, 'configured.md');
  const overridden = path.join(project, 'override.md');
  await writeFile(configured, '---\nname: Configured\n---\n\nYou are Configured.\n');
  await writeFile(overridden, '---\nname: Overridden\n---\n\nYou are Overridden.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'demo', soul: configured }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      // `stratus serve` would resolve this soul, not the configured one.
      processEnv: { STRATUS_SOUL: overridden },
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '3\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Overridden \(overridden\)/);
  assert.doesNotMatch(output.stdout, /Configured \(configured\)/);
  assert.match(output.stderr, /STRATUS_SOUL points at .*override\.md/);
});

test('doctor reports the resolved provider and where it came from', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const soulPath = path.join(agentsDir, 'ava.md');
  await writeFile(soulPath, '---\nname: Ava\n---\n\nYou are Ava.\n');
  const configPath = path.join(home, '.stratus', 'config.json');
  await writeFile(configPath, JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5', soul: soulPath }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-stored' } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 0, 'a healthy setup exits 0');
  // Every setting names the file that decided it — the whole point.
  assert.match(output.stdout, /provider {2}anthropic/);
  assert.match(output.stdout, new RegExp(`from ${configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(output.stdout, /model {5}claude-opus-5/);
  assert.match(output.stdout, /agent {5}Ava \(ava\)/);
  assert.match(output.stdout, /anthropic API key/);
  assert.match(output.stdout, /No problems found\./);
});

test('doctor explains a demo provider instead of leaving it a mystery', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // A stored sign-in does not select a provider — the config does. This is
  // the shape that makes a signed-in user think Claude is broken.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'demo' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-stored' } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1, 'problems make doctor exit non-zero');
  assert.match(output.stdout, /Provider is the offline demo model/);
  assert.match(output.stdout, /stratus setup/);
});

test('doctor flags an environment key that demotes a subscription sign-in', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      // Outranks the stored token, so the plan is silently not used.
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-from-env' },
    },
  });

  assert.equal(exitCode, 1);
  assert.match(output.stdout, /ANTHROPIC_API_KEY in your environment outranks/);
  assert.match(output.stdout, /billed per token instead of through your plan/);
});

test('doctor names the project config that outranks the global one', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  const shadow = path.join(project, 'stratus.config.json');
  await writeFile(shadow, JSON.stringify({ model: 'gpt-4.1-mini' }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: project, homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1);
  // The project file has no provider key, so the run silently falls to demo
  // even though the global config names anthropic.
  assert.match(output.stdout, /provider {2}demo/);
  assert.match(output.stdout, new RegExp(`${shadow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} outranks`));
  assert.match(output.stdout, /exists but is outranked/);
});

test('doctor --format json returns the same findings as data', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'demo' }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor', '--format', 'json'],
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1);
  const report = JSON.parse(output.stdout);
  assert.equal(report.provider.value, 'demo');
  assert.equal(report.slackPackageInstalled, true);
  assert.ok(report.problems.some((problem: string) => /offline demo model/.test(problem)));
});

test('a run warns when an environment key overrides the subscription sign-in', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );

  const { streams, output } = createStreams();
  // The run itself fails on the fake key; the warning has to arrive anyway,
  // because a working key is exactly when it goes unnoticed.
  await runCli({
    argv: ['run', 'hello'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-from-env' },
      fetch: (async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })) as typeof fetch,
    },
  });

  assert.match(output.stderr, /ANTHROPIC_API_KEY in your environment outranks the Claude subscription sign-in/);
});

test('doctor names the custom variable that actually supplied the key', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // apiKeyEnv points at a custom variable, and the config names anthropic
  // so the resolver honors it. Blaming ANTHROPIC_API_KEY here would send
  // the reader to unset something that was never the cause.
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'anthropic', apiKeyEnv: 'WORK_CLAUDE_KEY' }),
  );
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { WORK_CLAUDE_KEY: 'sk-ant-custom' },
    },
  });

  assert.equal(exitCode, 1);
  assert.match(output.stdout, /WORK_CLAUDE_KEY in your environment outranks/);
  assert.doesNotMatch(output.stdout, /Unset ANTHROPIC_API_KEY/);
});

test('doctor ignores an apiKeyEnv belonging to a different provider', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The config describes openai, so its apiKeyEnv is an openai variable.
  // STRATUS_PROVIDER selects anthropic, which strands it — the run uses
  // the stored subscription, so reporting per-token billing would be a lie.
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'openai', apiKeyEnv: 'MY_OPENAI_KEY' }),
  );
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { STRATUS_PROVIDER: 'anthropic', MY_OPENAI_KEY: 'sk-openai' },
    },
  });

  assert.equal(exitCode, 0, 'the subscription is intact, so nothing is wrong');
  assert.match(output.stdout, /anthropic Claude subscription \(Pro\/Max\) — runs go through the Claude Code runtime/);
  assert.doesNotMatch(output.stdout, /billed per token/);
});

test('doctor reports an explicit config path that does not exist', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor', '--config', './missing.json'],
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1);
  // A real run with this flag fails outright, so reporting built-in
  // defaults would describe a run that cannot happen.
  assert.match(output.stdout, /missing\.json does not exist/);
  assert.match(output.stdout, /every run with this setting fails/);
});

test('a run names the legacy variable when it supplied the key', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );

  const { streams, output } = createStreams();
  await runCli({
    argv: ['run', 'hello'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { STRATUSCLAW_API_KEY: 'sk-ant-legacy' },
      fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    },
  });

  assert.match(output.stderr, /STRATUSCLAW_API_KEY in your environment outranks/);
  assert.doesNotMatch(output.stderr, /ANTHROPIC_API_KEY in your environment/);
});

test('doctor reports an unreadable soul as fatal, not as a fallback', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'anthropic', soul: '/nowhere/ghost.md' }),
  );
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-x' } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1);
  // resolveRuntimeConfig propagates loadSoulFile's error — promising a
  // built-in fallback would send someone looking for a run that never happens.
  // The verdict is the resolver's own error, with the consequence spelled out.
  assert.match(output.stdout, /No run can start: Soul file not found: \/nowhere\/ghost\.md/);
  assert.match(output.stdout, /the built-in agent is not substituted/);
  assert.match(output.stdout, /agent {5}unresolved — the configured soul could not be read/);
  assert.doesNotMatch(output.stdout, /built-in — no soul configured/);
});

test('doctor attributes a legacy provider override to the legacy variable', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai' }));

  const { streams, output } = createStreams();
  await runCli({
    argv: ['doctor'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { STRATUSCLAW_PROVIDER: 'anthropic', STRATUSCLAW_MODEL: 'claude-opus-5' },
    },
  });

  // No anthropic sign-in, so no run can start — but the intended provider
  // and the variable that chose it are still what the reader needs.
  assert.match(output.stdout, /provider {2}anthropic \(unreachable\)\n {12}from STRATUSCLAW_PROVIDER/);
  assert.match(output.stdout, /No run can start: Missing API key for provider=anthropic/);
});

test('doctor reports a stored sign-in refused by an untrusted project endpoint', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'sk-unbound' } }),
  );
  // An auto-discovered project config could point anywhere, so the resolver
  // refuses to send an unbound stored key to the endpoint it names.
  await writeFile(
    path.join(project, 'stratus.config.json'),
    JSON.stringify({ provider: 'openai', baseUrl: 'https://evil.test/v1' }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: project, homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1, 'the run would fail, so this is not a healthy setup');
  assert.match(output.stdout, /No run can start:/);
  assert.match(output.stdout, /sets a custom base URL \(https:\/\/evil\.test\/v1\)/);
});

test('doctor stays quiet about a secondary provider no fallback targets', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }),
  );
  // A stored Anthropic subscription plus ANTHROPIC_API_KEY, with no
  // Anthropic fallback configured: no run ever reads that credential.
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      openai: { type: 'api_key', value: 'sk-openai' },
      anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' },
    }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-env' },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /anthropic Claude subscription \(Pro\/Max\) \(unused — openai serves your runs\)/);
  assert.doesNotMatch(output.stdout, /billed per token/);
});

test('doctor reports the fallback and flags one with no sign-in', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-4.1-mini',
  }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1);
  // The resolver drops a fallback it cannot use, so the config still names
  // one while a failing primary has nothing to retry on.
  assert.match(output.stdout, /A fallback model \(gpt-4\.1-mini\) is configured but could not be resolved/);
  assert.doesNotMatch(output.stdout, /fallback {2}openai/);
});

test('doctor treats a malformed config as fatal instead of showing defaults', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), '{ this is not json');

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1);
  // resolveRuntimeConfig propagates the parse failure, so no run reaches
  // provider or credential resolution at all.
  assert.match(output.stdout, /could not be parsed/);
  assert.match(output.stdout, /Every run fails until it is fixed or removed/);
  assert.doesNotMatch(output.stdout, /running as if it were empty/);
});

test('doctor diagnoses a bound key pointed at a different endpoint', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai' }));
  // The saved key belongs to one service; STRATUS_BASE_URL names another.
  // The resolver refuses to send it there, so the run always fails.
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ openai: { type: 'api_key', value: 'sk-local', baseUrl: 'http://localhost:1234/v1' } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { STRATUS_BASE_URL: 'https://api.openai.com/v1' },
    },
  });

  assert.equal(exitCode, 1, 'a run that always fails is not "No problems found"');
  assert.match(output.stdout, /No run can start:/);
  assert.match(output.stdout, /bound to http:\/\/localhost:1234\/v1/);
});

test('doctor reports a usable fallback and the warning covers a demoted one', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // OpenAI primary, Anthropic fallback: a saved subscription plus an
  // environment key means a fallback retry is billed per token.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    fallbackProvider: 'anthropic',
    fallbackModel: 'claude-opus-5',
  }));
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    openai: { type: 'api_key', value: 'sk-openai' },
    anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' },
  }));

  const doctor = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams: doctor.streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-env' },
    },
  });

  assert.equal(exitCode, 1);
  assert.match(doctor.output.stdout, /fallback {2}anthropic · claude-opus-5/);
  assert.match(doctor.output.stdout, /fallback runs are billed per token/);

  // The same case has to warn on an ordinary run, where the primary is
  // anthropic-free and the old check returned early.
  const run = createStreams();
  await runCli({
    argv: ['run', 'hello'],
    streams: run.streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    },
  });
  assert.match(run.output.stderr, /a fallback retry would be billed per token/);
});

test('serve warns at startup when an env key demotes the subscription', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await runCli({
    argv: ['serve', '--no-events'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      shutdownSignal: controller.signal,
    },
  });

  // A daemon bills every dispatch for as long as it runs, with nobody
  // watching — the costliest place for this to go unsaid.
  assert.match(output.stderr, /ANTHROPIC_API_KEY in your environment outranks the Claude subscription sign-in/);
});

test('the log writer appends owner-only JSONL and rotates by size', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir, maxBytes: 200, keep: 2 });

  for (let index = 0; index < 12; index += 1) {
    await writer.write({ ts: new Date(index * 1000).toISOString(), level: 'info', msg: `line ${index}` });
  }

  // Sessions carry prompts and tool output, so the trace is as sensitive
  // as the transcript it describes.
  const info = await stat(writer.path);
  assert.equal(info.mode & 0o777, 0o600);
  const names = (await readdir(dir)).sort();
  assert.ok(names.includes('stratusd.jsonl'), 'the live file stays at a stable name');
  assert.ok(names.some((name) => name.startsWith('stratusd.jsonl.')), 'rotation happened');
  assert.ok(names.length <= 3, `keep=2 plus the live file, got ${names.join(', ')}`);
});

test('recent records reach back through a rotated generation', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir, maxBytes: 220, keep: 3 });
  for (let index = 0; index < 10; index += 1) {
    await writer.write({ ts: new Date(index * 1000).toISOString(), level: 'info', msg: `line ${index}` });
  }

  // A rotation must not make the daemon look like it just started.
  const records = await readRecentRecords(dir, 10);
  assert.equal(records.length, 10);
  assert.deepEqual(records.map((record) => record.msg), Array.from({ length: 10 }, (_, i) => `line ${i}`));
});

test('logs filters by agent and can emit the raw records', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const dir = path.join(home, '.stratus', 'logs');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'stratusd.jsonl'), [
    JSON.stringify({ ts: '2026-08-17T14:32:07.000Z', level: 'event', event: 'tool.called', agentId: 'ava', sessionId: 'sess-1', detail: { tool: 'memory.remember' } }),
    JSON.stringify({ ts: '2026-08-17T14:32:08.000Z', level: 'event', event: 'tool.called', agentId: 'nova', sessionId: 'sess-2', detail: { tool: 'demo.echo' } }),
    '',
  ].join('\n'));

  const text = createStreams();
  assert.equal(await runCli({
    argv: ['logs', '--agent', 'ava'],
    streams: text.streams,
    env: { homeDir: home, cwd: home, processEnv: {} },
  }), 0);
  assert.match(text.output.stdout, /14:32:07 {2}ava {9}tool\.called tool=memory\.remember \[sess-1\]/);
  assert.doesNotMatch(text.output.stdout, /nova/);

  const json = createStreams();
  await runCli({
    argv: ['logs', '--session', 'sess-2', '--format', 'json'],
    streams: json.streams,
    env: { homeDir: home, cwd: home, processEnv: {} },
  });
  const parsed = JSON.parse(json.output.stdout.trim());
  assert.equal(parsed.agentId, 'nova');
  assert.equal(parsed.detail.tool, 'demo.echo');
});

test('logs render the whole session id and a detail that is not an object', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const dir = path.join(home, '.stratus', 'logs');
  await mkdir(dir, { recursive: true });
  // A channel session id is `channel:agent:team:conversation[:thread]`, so
  // eight characters of one is `slack:av` for every Slack conversation on
  // the machine — and this is the column you copy into `stratus logs
  // --session`, which matches on equality.
  await writeFile(path.join(dir, 'stratusd.jsonl'), [
    JSON.stringify({ ts: '2026-08-17T14:32:07.000Z', level: 'event', event: 'session.created', agentId: 'ava', sessionId: 'slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456' }),
    // Records are parsed from a file, not handed over in-process: another
    // version's line, or a hand-edited one, can carry a string here.
    JSON.stringify({ ts: '2026-08-17T14:32:08.000Z', level: 'event', event: 'tool.completed', agentId: 'ava', sessionId: 'sess-1', detail: 'memory.remember' }),
    '',
  ].join('\n'));

  const text = createStreams();
  assert.equal(await runCli({
    argv: ['logs'],
    streams: text.streams,
    env: { homeDir: home, cwd: home, processEnv: {} },
  }), 0);
  assert.match(text.output.stdout, /session\.created \[slack:ava:T01ABCDEF:C07GHIJKL:1731900000\.123456\]/);
  assert.match(text.output.stdout, /tool\.completed memory\.remember \[sess-1\]/);
});

test('following the log picks up new lines and survives a rotation', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir, maxBytes: 160, keep: 2 });
  await writer.write({ ts: new Date(0).toISOString(), level: 'info', msg: 'before the tail' });

  const seen: string[] = [];
  const controller = new AbortController();
  const tail = tailLog({
    dir,
    intervalMs: 10,
    signal: controller.signal,
    onRecord: (record) => {
      seen.push(String(record.msg));
      // Enough to have crossed the rotation threshold above.
      if (seen.length >= 6) {
        controller.abort();
      }
    },
  });

  for (let index = 0; index < 6; index += 1) {
    await writer.write({ ts: new Date(index * 1000).toISOString(), level: 'info', msg: `after ${index}` });
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  await tail;

  // The backlog is not replayed, and rotation mid-tail loses nothing.
  assert.ok(!seen.includes('before the tail'), 'following starts at the current end');
  assert.deepEqual(seen, Array.from({ length: 6 }, (_, i) => `after ${i}`));
});

test('serve writes what it says to the log file, and --no-log-file opts out', async () => {
  const serveHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await runCli({
    argv: ['serve', '--no-events'],
    streams: createStreams().streams,
    env: { homeDir: serveHome, cwd: serveHome, processEnv: {}, shutdownSignal: controller.signal },
  });

  const records = await readRecentRecords(path.join(serveHome, '.stratus', 'logs'), 50);
  assert.ok(
    records.some((record) => /stratusd ready/.test(String(record.msg))),
    'the daemon line survives its terminal',
  );

  const quietHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  const quiet = new AbortController();
  setTimeout(() => quiet.abort(), 150);
  await runCli({
    argv: ['serve', '--no-events', '--no-log-file'],
    streams: createStreams().streams,
    env: { homeDir: quietHome, cwd: quietHome, processEnv: {}, shutdownSignal: quiet.signal },
  });
  assert.deepEqual(await readRecentRecords(path.join(quietHome, '.stratus', 'logs'), 50), []);
});

test('parseCommand parses logs options', () => {
  assert.deepEqual(parseCommand(['logs']), { command: 'logs', follow: false, limit: 50, format: 'text' });
  assert.deepEqual(parseCommand(['logs', '-f', '-n', '10', '--agent', 'ava', '--session', 's1', '--format', 'json']), {
    command: 'logs',
    follow: true,
    limit: 10,
    format: 'json',
    agentId: 'ava',
    sessionId: 's1',
  });
  assert.deepEqual(parseCommand(['serve', '--no-log-file']), { command: 'serve', events: true, logToFile: false });
});

test('following the log keeps the records that rotation moved aside', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  // Sized so the fifth write is the one that rotates: the follower is then
  // mid-file when its bytes move to .1, which is the case that silently
  // loses the events around a rotation.
  const writer = createLogWriter({ dir, maxBytes: 220, keep: 3 });
  const line = async (n: number): Promise<void> =>
    writer.write({ ts: new Date(n * 1000).toISOString(), level: 'info', msg: `burst ${n}` });

  await line(1);
  await line(2);
  // Where a follower would have been when the rotation happened — the
  // file identity travels with the offset, or the offset points into the
  // replacement instead of the file those bytes actually belong to.
  const from = await currentLogPosition(dir);
  await line(3);
  await line(4);
  await line(5);

  const rotated = (await readdir(dir)).filter((name) => name.startsWith('stratusd.jsonl.'));
  assert.deepEqual(rotated, ['stratusd.jsonl.1'], 'exactly one rotation, or the test is not measuring this');

  const seen: string[] = [];
  const controller = new AbortController();
  const tail = tailLog({
    dir,
    intervalMs: 5,
    startPosition: from,
    signal: controller.signal,
    onRecord: (record) => seen.push(String(record.msg)),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();
  await tail;

  // 3 and 4 were in the file that became .1; 5 is in its replacement.
  assert.deepEqual(seen, ['burst 3', 'burst 4', 'burst 5']);
});

test('a zero backlog limit prints nothing', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir });
  for (let index = 0; index < 5; index += 1) {
    await writer.write({ ts: new Date(index * 1000).toISOString(), level: 'info', msg: `line ${index}` });
  }

  // slice(-0) is slice(0) — `-n 0 -f` would otherwise replay the whole file.
  assert.deepEqual(await readRecentRecords(dir, 0), []);
});

test('following resumes from before the backlog was read', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir });
  await writer.write({ ts: new Date(0).toISOString(), level: 'info', msg: 'old' });

  // The daemon keeps writing while a backlog prints. Capturing the offset
  // first is what keeps these records from falling between the two reads.
  const from = await currentLogPosition(dir);
  await writer.write({ ts: new Date(1000).toISOString(), level: 'info', msg: 'written during the backlog print' });

  const seen: string[] = [];
  const controller = new AbortController();
  const tail = tailLog({
    dir,
    intervalMs: 5,
    startPosition: from,
    signal: controller.signal,
    onRecord: (record) => seen.push(String(record.msg)),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();
  await tail;

  assert.deepEqual(seen, ['written during the backlog print']);
});

test('streamed deltas never reach the log writer', async () => {
  // EventBus.emit awaits subscribers and a streaming provider awaits the
  // delta sink, so a write here would sit on the critical path of every
  // token. Deltas carry no detail worth keeping either.
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir });
  await writer.write({ ts: new Date(0).toISOString(), level: 'event', event: 'tool.called', agentId: 'ava', sessionId: 's' });

  const records = await readRecentRecords(dir, 10);
  assert.ok(records.every((record) => record.event !== 'provider.delta'));
  assert.equal(records.length, 1);
});

test('serve warns for a roster agent whose soul pins the demoted provider', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  // The daemon's own default is openai, but this agent pins anthropic and
  // the gateway resolves its soul independently on every dispatch — so it
  // is the agent being billed, and the default-only check missed it.
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\nprovider: anthropic\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai' }));
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    openai: { type: 'api_key', value: 'sk-openai' },
    anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' },
  }));

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await runCli({
    argv: ['serve', '--no-events'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      shutdownSignal: controller.signal,
    },
  });

  assert.match(output.stderr, /ANTHROPIC_API_KEY in your environment outranks the Claude subscription sign-in/);
  // One line, however many agents share the cause.
  assert.equal(output.stderr.match(/outranks the Claude subscription/g)?.length, 1);
});

test('doctor stops discovery at the first unreadable config', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  // A directory where a file is expected: readable() fails with EISDIR, and
  // resolveConfigLocation throws rather than trying the global config.
  await mkdir(path.join(project, 'stratus.config.json'), { recursive: true });

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: project, homeDir: home, processEnv: {} },
  });

  assert.equal(exitCode, 1);
  assert.match(output.stdout, /exists but cannot be read/);
  assert.match(output.stdout, /discovery never reaches a lower-priority config/);
  // The global file is never active for runs started here, so naming it as
  // the config in use would point at the wrong file entirely.
  assert.doesNotMatch(output.stdout, new RegExp(`config {4}${path.join(home, '.stratus', 'config.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('doctor blames the setting that actually selected demo', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // Setup writes the config, which is the lowest precedence of the three —
  // so "run setup" here would change nothing and leave runs on demo.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));

  const { streams, output } = createStreams();
  await runCli({
    argv: ['doctor'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { STRATUS_PROVIDER: 'demo' },
    },
  });

  assert.match(output.stdout, /Unset STRATUS_PROVIDER; it outranks both your config and any soul/);
  assert.doesNotMatch(output.stdout, /Run `stratus setup` → Providers and sign in/);
});

test('rotation is detected even when the replacement outgrows the old offset', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir, maxBytes: 220, keep: 3 });
  const line = async (n: number): Promise<void> =>
    writer.write({ ts: new Date(n * 1000).toISOString(), level: 'info', msg: `burst ${n}` });

  await line(1);
  await line(2);
  const from = await currentLogPosition(dir);
  await line(3);
  await line(4);
  // Rotates, then the replacement is grown well past `from.offset` before
  // any poll happens. A size comparison reads that as "the file grew" and
  // starts partway into the new file, losing both the old tail and the new
  // prefix — only the file's identity distinguishes the two cases.
  await line(5);
  await line(6);
  await line(7);
  assert.ok((await currentLogPosition(dir)).offset > from.offset, 'the replacement must outgrow the old offset');

  const seen: string[] = [];
  const controller = new AbortController();
  const tail = tailLog({
    dir,
    intervalMs: 5,
    startPosition: from,
    signal: controller.signal,
    onRecord: (record) => seen.push(String(record.msg)),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();
  await tail;

  assert.deepEqual(seen, ['burst 3', 'burst 4', 'burst 5', 'burst 6', 'burst 7']);
});

test('the backlog stops where following begins', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir });
  await writer.write({ ts: new Date(0).toISOString(), level: 'info', msg: 'before' });

  const from = await currentLogPosition(dir);
  // Written after the follow offset is captured but before the backlog is
  // read: it belongs to the stream, and printing it in both is a duplicate.
  await writer.write({ ts: new Date(1000).toISOString(), level: 'info', msg: 'in between' });

  const backlog = await readRecentRecords(dir, 50, {}, from);
  assert.deepEqual(backlog.map((record) => record.msg), ['before']);

  const seen: string[] = [];
  const controller = new AbortController();
  const tail = tailLog({
    dir,
    intervalMs: 5,
    startPosition: from,
    signal: controller.signal,
    onRecord: (record) => seen.push(String(record.msg)),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();
  await tail;

  // Exactly once, between the two halves — no gap and no repeat.
  assert.deepEqual(seen, ['in between']);
});

test('serve applies the gateway soul-pin demotion before checking an agent', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\nprovider: anthropic\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai' }));
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    openai: { type: 'api_key', value: 'sk-openai' },
    anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' },
  }));

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 250);
  await runCli({
    argv: ['serve', '--no-events'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      // STRATUS_PROVIDER supplies the daemon default. A dispatch to Ava
      // drops it because her soul pins a provider, then resolves anthropic
      // with the environment key — so resolving with the pin bolted onto
      // an unmodified environment checks openai and never warns.
      processEnv: { STRATUS_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'sk-ant-env' },
      shutdownSignal: controller.signal,
    },
  });

  assert.match(output.stderr, /ANTHROPIC_API_KEY in your environment outranks the Claude subscription sign-in/);
});

test('doctor names the legacy config variable that pointed at a missing file', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: { STRATUSCLAW_CONFIG: './gone.json' },
    },
  });

  assert.equal(exitCode, 1);
  assert.match(output.stdout, /gone\.json does not exist, but STRATUSCLAW_CONFIG names it/);
  assert.doesNotMatch(output.stdout, /but STRATUS_CONFIG names it/);
});

test('following recovers whole generations after several rotations', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir, maxBytes: 150, keep: 5 });
  const line = async (n: number): Promise<void> =>
    writer.write({ ts: new Date(n * 1000).toISOString(), level: 'info', msg: `burst ${n}` });

  await line(1);
  const from = await currentLogPosition(dir);
  // Enough writes to rotate more than once: the file `from` refers to ends
  // up at .2 or later, and every generation in between is a complete file
  // the follower never saw. Checking only .1 would drop all of them.
  for (let index = 2; index <= 9; index += 1) {
    await line(index);
  }
  const generations = (await readdir(dir)).filter((name) => name.startsWith('stratusd.jsonl.'));
  assert.ok(generations.length >= 2, `expected several rotations, got ${generations.join(', ')}`);

  const seen: string[] = [];
  const controller = new AbortController();
  const tail = tailLog({
    dir,
    intervalMs: 5,
    startPosition: from,
    signal: controller.signal,
    onRecord: (record) => seen.push(String(record.msg)),
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  controller.abort();
  await tail;

  assert.deepEqual(seen, Array.from({ length: 8 }, (_, i) => `burst ${i + 2}`));
});

test('the backlog cutoff follows the file it was captured in', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir, maxBytes: 150, keep: 3 });
  const line = async (n: number): Promise<void> =>
    writer.write({ ts: new Date(n * 1000).toISOString(), level: 'info', msg: `line ${n}` });

  await line(1);
  const from = await currentLogPosition(dir);
  // Rotation between capturing the cutoff and reading the backlog: applying
  // the offset to the replacement would truncate the wrong file and read
  // the old one whole, printing everything past the cutoff twice.
  await line(2);
  await line(3);
  await line(4);

  const backlog = await readRecentRecords(dir, 50, {}, from);
  assert.deepEqual(backlog.map((record) => record.msg), ['line 1']);
});

test('the live log is tightened to owner-only even when it already exists', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  await mkdir(dir, { recursive: true });
  // A log left behind by an older build, a restored backup, or a looser
  // umask: appendFile's mode applies only when it creates the file.
  const logPath = path.join(dir, 'stratusd.jsonl');
  await writeFile(logPath, '', { mode: 0o644 });
  await chmod(logPath, 0o644);

  const writer = createLogWriter({ dir });
  await writer.write({ ts: new Date(0).toISOString(), level: 'info', msg: 'hello' });

  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
});

test('serve writes its credential warning to the log, not just to stderr', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await runCli({
    argv: ['serve', '--no-events'],
    streams: createStreams().streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      shutdownSignal: controller.signal,
    },
  });

  // Under a service manager stderr is gone; a cost warning that lives only
  // there is invisible in the deployment it matters for.
  const records = await readRecentRecords(path.join(home, '.stratus', 'logs'), 50);
  assert.ok(
    records.some((record) => record.level === 'warn' && /outranks the Claude subscription/.test(String(record.msg))),
    'the warning has to survive in the log',
  );
});

test('the Channels menu connects the built-in agent on a fresh install', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      // No soul files anywhere. The gateway still answers agentId-less
      // dispatches as the built-in Stratus agent, so it has to be
      // connectable here — otherwise Slack is unreachable until you
      // create an agent you may not want.
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '1\n', 'xapp-t\n', 'xoxb-t\n', '2\n', '7\n']),
      fetch: (async (url: any) => new Response(JSON.stringify(
        String(url).endsWith('/auth.test')
          ? { ok: true, user_id: 'B7', team: 'Acme', team_id: 'T7' }
          : { ok: true, url: 'wss://x' },
      ), { status: 200 })) as typeof fetch,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Stratus \(stratus\)/);
  assert.match(output.stdout, /✓ Verified — Stratus is connected to Slack in Acme/);
  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials.channels, { slack: { stratus: { appToken: 'xapp-t', botToken: 'xoxb-t' } } });
});

test('a roster file claiming the built-in id is skipped in the Channels menu', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  // The gateway reserves "stratus" before the roster loads and skips this
  // file with a duplicate warning, so offering "Impostor" here would name
  // an app for an agent that never receives a message.
  await writeFile(path.join(agentsDir, 'impostor.md'), '---\nname: Impostor\nid: stratus\n---\n\nYou are not Stratus.\n');

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '2\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Stratus \(stratus\)/);
  assert.doesNotMatch(output.stdout, /Impostor \(stratus\)/);
  // Reserved, not duplicated: a soul may not take over the documented
  // fallback, and that is a skip rather than the collision between two
  // soul files that refuses the whole roster.
  assert.match(output.stderr, /agent id stratus is reserved for the built-in agent/);
  assert.match(output.stderr, /impostor\.md/);
});

test('the Channels menu can clear orphaned tokens with no soul files present', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The agent these tokens belonged to was deleted. `stratus serve` still
  // loads and skips them on every start, and this menu is the only place
  // they can be removed — so an empty roster must not short-circuit it.
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ channels: { slack: { ghost: { appToken: 'xapp-x', botToken: 'xoxb-x' } } } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      // Channels → the orphan (2, after the built-in) → Remove → Back → Save
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '2\n', '1\n', '3\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /tokens without a matching agent/);
  assert.match(output.stdout, /Removed the Slack tokens for ghost\./);
  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials.channels, { slack: {} });
});

test('the launchd plist runs the daemon by absolute path and starts at login', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await installService({
    platform: 'darwin',
    homeDir: home,
    execPath: '/opt/homebrew/bin/node',
    scriptPath: '/opt/homebrew/lib/node_modules/@stratusagent/cli/dist/bin.js',
    uid: 501,
    run: async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: '', stderr: '' }; },
  });

  assert.equal(result.ok, true);
  const plist = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.stratusagent.stratusd.plist'), 'utf8');
  // A service manager starts with a minimal environment, so a bare
  // `stratus` would depend on a shell profile it never loads.
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /dist\/bin\.js<\/string>/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // Restart on crash, but not on a clean SIGTERM shutdown.
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);

  // bootout before bootstrap, or replacing an existing job is refused with
  // "service already loaded" and the new unit never takes effect.
  assert.deepEqual(calls.map((call) => `${call.command} ${call.args[0]}`), ['launchctl bootout', 'launchctl bootstrap']);
  assert.equal(calls[1]?.args[1], 'gui/501');
  // The login-vs-power-on distinction is stated, not left to be discovered
  // after a reboot leaves the roster silent.
  assert.ok(result.messages.some((message) => /starts at login, not at power-on/.test(message)));
});

test('--no-login installs the service without the login trigger', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService(
    { platform: 'darwin', homeDir: home, uid: 501, run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    { runAtLogin: false },
  );
  const plist = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.stratusagent.stratusd.plist'), 'utf8');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
});

test('the systemd unit restarts on failure and enables at login', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const calls: string[] = [];
  const result = await installService({
    platform: 'linux',
    homeDir: home,
    execPath: '/usr/bin/node',
    scriptPath: '/usr/lib/node_modules/@stratusagent/cli/dist/bin.js',
    run: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
  });

  assert.equal(result.ok, true);
  const unit = await readFile(path.join(home, '.config', 'systemd', 'user', 'stratusd.service'), 'utf8');
  assert.match(unit, /ExecStart="\/usr\/bin\/node" ".*bin\.js" "serve"/);
  assert.match(unit, /Restart=on-failure/);
  // serve drains on SIGTERM, so systemd must send it and wait.
  assert.match(unit, /KillSignal=SIGTERM/);
  assert.match(unit, /WantedBy=default\.target/);
  // The restart is not redundant: `enable --now` no-ops on an already
  // active unit, so a rerun would leave the old process — and its old
  // config path — running while reporting the new unit as installed.
  assert.deepEqual(calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable --now stratusd.service',
    'systemctl --user restart stratusd.service',
  ]);
});

test('a failing service manager is reported, not swallowed', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['service', 'install'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      serviceRunner: async (command) => (command === 'launchctl'
        ? { code: 1, stdout: '', stderr: 'Load failed: 5: Input/output error' }
        : { code: 1, stdout: '', stderr: 'Failed to connect to bus' }),
    },
  });

  assert.equal(exitCode, 1);
  assert.match(output.stderr, /failed/i);
});

test('service status distinguishes not installed, installed, and running', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));

  const missing = await readServiceStatus({ platform: 'linux', homeDir: home, run: async () => ({ code: 3, stdout: 'inactive', stderr: '' }) });
  assert.equal(missing?.installed, false);
  assert.equal(missing?.running, false);

  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });

  // A unit on disk the manager has not started is installed but inert.
  const stopped = await readServiceStatus({ platform: 'linux', homeDir: home, run: async () => ({ code: 3, stdout: 'inactive\n', stderr: '' }) });
  assert.equal(stopped?.installed, true);
  assert.equal(stopped?.running, false);

  const running = await readServiceStatus({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: 'active\n', stderr: '' }) });
  assert.equal(running?.running, true);
});

test('uninstall tells the manager before removing the unit file', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const seen: string[] = [];
  await installService({ platform: 'darwin', homeDir: home, uid: 501, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const unitPath = serviceUnitPath({ platform: 'darwin', homeDir: home });

  await uninstallService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    run: async (command, args) => {
      // Removing the file first would leave a running job with no unit to
      // stop it by.
      seen.push([command, ...args].join(' '));
      assert.ok(await readFile(unitPath, 'utf8').catch(() => undefined), 'the unit is still on disk while stopping');
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(seen, ['launchctl bootout gui/501/com.stratusagent.stratusd']);
  assert.equal(await readFile(unitPath, 'utf8').catch(() => undefined), undefined);
});

test('setup installs the always-on service when it saves', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // A stored sign-in, or the install is refused — a daemon that cannot
  // authenticate is worse than no daemon.
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-stored' } }),
  );
  const calls: string[] = [];

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
      // Straight to Save & finish: the service is on by default, because a
      // runtime you have to remember to start is not always-on.
      setupInput: Readable.from(['7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(calls.some((call) => /enable --now|bootstrap/.test(call)), `expected an install, got ${calls.join(', ')}`);
  assert.match(output.stdout, /will start again when you log in/);
});

test('setup can be told not to run the service', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const calls: string[] = [];

  const { streams, output } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
      // Always on → "Do not run it for me" → Save & finish.
      setupInput: Readable.from(['5\n', '3\n', '7\n']),
    },
  });

  assert.deepEqual(calls, [], 'nothing should be handed to the service manager');
  assert.match(output.stdout, /Always on {12}off/);
});

test('parseCommand parses service actions', () => {
  assert.deepEqual(parseCommand(['service', 'install']), { command: 'service', action: 'install' });
  assert.deepEqual(parseCommand(['service', 'install', '--no-login']), { command: 'service', action: 'install', runAtLogin: false });
  assert.deepEqual(parseCommand(['service', 'status']), { command: 'service', action: 'status' });
  assert.throws(() => parseCommand(['service', 'restart']), /Unknown service action/);
  assert.throws(() => parseCommand(['service', 'status', '--no-login']), /applies to/);
});

test('the managed daemon is pinned to the config setup wrote', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-stored' } }),
  );

  const { streams } = createStreams();
  await runCli({
    argv: ['setup', '--config', './custom.json'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['7\n']),
    },
  });

  // The unit's working directory is the home directory, so discovery from
  // there would find a different config entirely — the daemon would come up
  // on the wrong roster and leave configured Slack agents offline.
  const unit = await readFile(path.join(home, '.config', 'systemd', 'user', 'stratusd.service'), 'utf8');
  // --no-events sits between them: the managed daemon keeps stdout to
  // lifecycle lines, since launchd's redirect file is never rotated.
  assert.match(unit, /"serve" "--no-events" "--config" "[^"]*custom\.json"/);
});

test('service install can pin the daemon to a config of its own', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-'));

  await writeFile(path.join(project, 'team.json'), JSON.stringify({ provider: 'demo' }));
  await runCli({
    argv: ['service', 'install', '--config', './team.json'],
    streams: createStreams().streams,
    env: { cwd: project, homeDir: home, processEnv: {}, serviceRunner: stubServiceRunner },
  });

  const unit = await readFile(path.join(home, '.config', 'systemd', 'user', 'stratusd.service'), 'utf8');
  // Resolved against the invoking directory, not the home the unit runs in.
  assert.match(unit, new RegExp(`"--config" "${path.join(project, 'team.json')}"`));
});

test('a --no-login LaunchAgent does not smuggle RunAtLoad back in', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const calls: string[] = [];
  const result = await installService(
    {
      platform: 'darwin',
      homeDir: home,
      uid: 501,
      run: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
    },
    { runAtLogin: false },
  );

  const plist = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.stratusagent.stratusd.plist'), 'utf8');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  // launchd's KeepAlive.SuccessfulExit implies RunAtLoad — the job has to
  // run to produce an exit status — so keeping it would restart the agent
  // at every login and quietly contradict the flag.
  assert.doesNotMatch(plist, /KeepAlive/);
  // Which means bootstrap alone will not start it: it is kickstarted.
  assert.ok(calls.some((call) => /kickstart/.test(call)), calls.join(', '));
  assert.equal(result.ok, true);
  assert.ok(result.messages.some((message) => /will not start at login/.test(message)));
});

test('reinstalling with --no-login clears an existing systemd enablement', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  await installService({ platform: 'linux', homeDir: home, run });

  const calls: string[] = [];
  await installService(
    { platform: 'linux', homeDir: home, run: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; } },
    { runAtLogin: false },
  );

  // `start` alone leaves the enablement symlink from the first install, so
  // the unit keeps starting at login despite the success message.
  assert.deepEqual(calls, [
    'systemctl --user daemon-reload',
    'systemctl --user disable stratusd.service',
    'systemctl --user start stratusd.service',
    'systemctl --user restart stratusd.service',
  ]);
});

test('systemd status asks whether the unit is enabled', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });

  // The unit file says nothing about enablement — that lives in a symlink,
  // so a unit installed with --no-login would otherwise be reported as
  // starting at login, contradicting its own install output.
  const disabled = await readServiceStatus({
    platform: 'linux',
    homeDir: home,
    run: async (_command, args) => (args.includes('is-enabled')
      ? { code: 1, stdout: 'disabled\n', stderr: '' }
      : { code: 0, stdout: 'active\n', stderr: '' }),
  });
  assert.equal(disabled?.runAtLogin, false);

  const enabled = await readServiceStatus({
    platform: 'linux',
    homeDir: home,
    run: async (_command, args) => (args.includes('is-enabled')
      ? { code: 0, stdout: 'enabled\n', stderr: '' }
      : { code: 0, stdout: 'active\n', stderr: '' }),
  });
  assert.equal(enabled?.runAtLogin, true);
});

test('uninstall keeps the unit when the manager could not stop the daemon', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'darwin', homeDir: home, uid: 501, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const unitPath = serviceUnitPath({ platform: 'darwin', homeDir: home });

  const result = await uninstallService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    run: async () => ({ code: 124, stdout: '', stderr: 'launchctl did not respond within 15s' }),
  });

  assert.equal(result.ok, false);
  // Removing it anyway would strand a live daemon with nothing left to stop
  // it by, while reporting that it had been shut down.
  assert.ok(await readFile(unitPath, 'utf8').catch(() => undefined), 'the unit must survive a failed stop');
  assert.ok(result.messages.some((message) => /left in place/.test(message)));
});

test('uninstall still cleans up a unit the manager never loaded', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'darwin', homeDir: home, uid: 501, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const unitPath = serviceUnitPath({ platform: 'darwin', homeDir: home });

  // Nothing to stop is not a failure to stop.
  const result = await uninstallService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    run: async () => ({ code: 3, stdout: '', stderr: 'Could not find service "com.stratusagent.stratusd"' }),
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(unitPath, 'utf8').catch(() => undefined), undefined);
});

test('the unit runs where it was installed, so relative config paths still work', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-project-'));

  await runCli({
    argv: ['service', 'install'],
    streams: createStreams().streams,
    env: { cwd: project, homeDir: home, processEnv: {}, serviceRunner: stubServiceRunner },
  });

  // A config's `soul` resolves against the process working directory, so
  // forcing the home directory would make the service load a different —
  // or missing — soul than `stratus serve` does from the same project.
  const unit = await readFile(path.join(home, '.config', 'systemd', 'user', 'stratusd.service'), 'utf8');
  assert.match(unit, new RegExp(`WorkingDirectory=${project}`));
});

test('a failed disable stops --no-login claiming the login trigger is gone', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const result = await installService(
    {
      platform: 'linux',
      homeDir: home,
      run: async (_command, args) => (args.includes('disable')
        ? { code: 1, stdout: '', stderr: 'Failed to disable: permission denied' }
        : { code: 0, stdout: '', stderr: '' }),
    },
    { runAtLogin: false },
  );

  assert.equal(result.ok, false);
  assert.ok(result.messages.some((message) => /Could not remove the login trigger/.test(message)));
  assert.ok(!result.messages.some((message) => /will not start automatically/.test(message)));
});

test('a unit that was never enabled is not treated as a failed disable', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const result = await installService(
    {
      platform: 'linux',
      homeDir: home,
      run: async (_command, args) => (args.includes('disable')
        ? { code: 1, stdout: '', stderr: 'Unit stratusd.service is not enabled' }
        : { code: 0, stdout: '', stderr: '' }),
    },
    { runAtLogin: false },
  );

  assert.equal(result.ok, true);
});

test('a stored sign-in installs the service as usual', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-stored' } }),
  );

  const calls: string[] = [];
  await runCli({
    argv: ['setup'],
    streams: createStreams().streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
      setupInput: Readable.from(['7\n']),
    },
  });

  assert.ok(calls.some((call) => /enable --now/.test(call)), calls.join(', '));
});

test('opting out in setup removes a service an earlier run installed', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const unitPath = serviceUnitPath({ platform: 'linux', homeDir: home });
  assert.ok(await readFile(unitPath, 'utf8').catch(() => undefined), 'installed to begin with');

  const calls: string[] = [];
  const { streams } = createStreams();
  await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
      // Always on → "Do not run it for me" → Save & finish.
      setupInput: Readable.from(['5\n', '3\n', '7\n']),
    },
  });

  // Skipping the install would leave the daemon running and enabled while
  // the menu said "off" — still burning usage and still answering in Slack.
  assert.ok(calls.some((call) => /disable --now/.test(call)), calls.join(', '));
  assert.equal(await readFile(unitPath, 'utf8').catch(() => undefined), undefined);
});

test('starting a LaunchAgent works after it has been booted out', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'darwin', homeDir: home, uid: 501, run: async () => ({ code: 0, stdout: '', stderr: '' }) });

  const calls: string[] = [];
  const result = await startService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    run: async (command, args) => {
      calls.push([command, ...args].join(' '));
      // kickstart cannot find a job that bootout removed from the domain.
      return args[0] === 'kickstart' && !calls.some((call) => call.includes('bootstrap'))
        ? { code: 3, stdout: '', stderr: 'Could not find service' }
        : { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.includes('bootstrap'), true, `expected a bootstrap first, got ${calls.join(', ')}`);
  assert.ok(calls.some((call) => /kickstart/.test(call)));
});

test('stopping a --no-login service does not promise it comes back at login', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService(
    { platform: 'darwin', homeDir: home, uid: 501, run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    { runAtLogin: false },
  );

  const quiet = await stopService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  // Believing it will return at login leaves the agents offline indefinitely.
  assert.ok(quiet.messages.some((message) => /NOT start again on its own/.test(message)), quiet.messages.join(' '));

  await installService({ platform: 'darwin', homeDir: home, uid: 501, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const managed = await stopService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.ok(managed.messages.some((message) => /start again at your next login/.test(message)));
});

test('systemd unit values escape percent signs', async () => {
  // systemd expands % specifiers in unit values, including inside quoted
  // ExecStart arguments — %b becomes the boot id, so a path containing one
  // silently turns into a nonexistent executable or directory.
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const odd = path.join(home, '100%b-project');
  await mkdir(odd, { recursive: true });

  await installService({
    platform: 'linux',
    homeDir: home,
    cwd: odd,
    execPath: '/usr/bin/node',
    scriptPath: path.join(odd, 'bin.js'),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  const unit = await readFile(path.join(home, '.config', 'systemd', 'user', 'stratusd.service'), 'utf8');
  assert.match(unit, /100%%b-project/);
  assert.doesNotMatch(unit, /100%b-project/);
});

test('rerunning setup keeps an existing --no-login install as it was', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-stored' } }),
  );
  await installService(
    { platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    { runAtLogin: false },
  );

  const calls: string[] = [];
  await runCli({
    argv: ['setup'],
    streams: createStreams().streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => {
        calls.push([command, ...args].join(' '));
        return args.includes('is-enabled')
          ? { code: 1, stdout: 'disabled\n', stderr: '' }
          : { code: 0, stdout: '', stderr: '' };
      },
      // Straight to Save & finish, without visiting Always on.
      setupInput: Readable.from(['7\n']),
    },
  });

  // Saving must not quietly undo a deliberate `service install --no-login`.
  assert.ok(!calls.some((call) => /enable --now/.test(call)), calls.join(', '));
  assert.ok(calls.some((call) => /--user start/.test(call)), calls.join(', '));
});

test('service install pins the config STRATUS_CONFIG selected', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-'));

  await writeFile(path.join(project, 'team.json'), JSON.stringify({ provider: 'demo' }));
  await runCli({
    argv: ['service', 'install'],
    streams: createStreams().streams,
    env: {
      cwd: project,
      homeDir: home,
      // A service manager passes none of this shell on, so a config chosen
      // here has to be baked into the unit or the daemon rediscovers and
      // can come up on a different roster.
      processEnv: { STRATUS_CONFIG: './team.json' },
      serviceRunner: stubServiceRunner,
    },
  });

  const unit = await readFile(path.join(home, '.config', 'systemd', 'user', 'stratusd.service'), 'utf8');
  assert.match(unit, new RegExp(`"--config" "${path.join(project, 'team.json')}"`));
});

test('an unanswerable enablement query is not read as --no-login', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });

  // A broken user bus exits non-zero with nothing on stdout, which looks
  // exactly like "disabled" unless the known states are checked.
  const unknown = await readServiceStatus({
    platform: 'linux',
    homeDir: home,
    run: async (_command, args) => (args.includes('is-enabled')
      ? { code: 1, stdout: '', stderr: 'Failed to connect to bus' }
      : { code: 0, stdout: 'active\n', stderr: '' }),
  });
  assert.equal(unknown?.runAtLogin, undefined);

  const disabled = await readServiceStatus({
    platform: 'linux',
    homeDir: home,
    run: async (_command, args) => (args.includes('is-enabled')
      ? { code: 1, stdout: 'disabled\n', stderr: '' }
      : { code: 0, stdout: 'active\n', stderr: '' }),
  });
  assert.equal(disabled?.runAtLogin, false);
});

test('a transient status failure does not disable a service on the next save', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-stored' } }),
  );
  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });

  const calls: string[] = [];
  await runCli({
    argv: ['setup'],
    streams: createStreams().streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => {
        calls.push([command, ...args].join(' '));
        return args.includes('is-enabled')
          ? { code: 1, stdout: '', stderr: 'Failed to connect to bus' }
          : { code: 0, stdout: '', stderr: '' };
      },
      setupInput: Readable.from(['7\n']),
    },
  });

  // Reading the failure as "they chose --no-login" would quietly strip an
  // enabled service's login startup.
  assert.ok(calls.some((call) => /enable --now/.test(call)), calls.join(', '));
  assert.ok(!calls.some((call) => /--user disable/.test(call)), calls.join(', '));
});

test('service install refuses a config the daemon could not parse', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-'));
  await writeFile(path.join(project, 'broken.json'), '{ not json');

  const calls: string[] = [];
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['service', 'install', '--config', './broken.json'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
    },
  });

  // Installing would let the manager accept the start, then restart the
  // daemon in a loop as it exits on the unreadable config.
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.match(output.stderr, /cannot be used/);
  assert.match(output.stderr, /restarted in a loop/);
});

test('systemd ExecStart escapes dollar signs as well as percents', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const odd = path.join(home, 'proj-${HOME}-100%');
  await mkdir(odd, { recursive: true });

  await installService({
    platform: 'linux',
    homeDir: home,
    cwd: odd,
    execPath: '/usr/bin/node',
    scriptPath: path.join(odd, 'bin.js'),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  const unit = await readFile(path.join(home, '.config', 'systemd', 'user', 'stratusd.service'), 'utf8');
  const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
  // JSON quoting does not disable systemd's expansion; systemd.service(5)
  // spells a literal dollar `$$`.
  assert.match(String(execStart), /\$\$\{HOME\}/);
  assert.match(String(execStart), /100%%/);
  // WorkingDirectory is not a command line, so it takes % escaping only.
  assert.match(unit, /WorkingDirectory=.*\$\{HOME\}-100%%/);
});

test('an unanswerable enablement is reported as unknown, not as no', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const brokenBus: ServiceRunner = async (_command, args) => (args.includes('is-enabled')
    ? { code: 1, stdout: '', stderr: 'Failed to connect to bus' }
    : { code: 0, stdout: 'active\n', stderr: '' });

  const { streams, output } = createStreams();
  await runCli({
    argv: ['service', 'status'],
    streams,
    env: { cwd: home, homeDir: home, processEnv: {}, serviceRunner: brokenBus },
  });
  assert.match(output.stdout, /at login {2}unknown — the service manager did not answer/);

  // Stopping must not claim it will never come back either.
  const stopped = await stopService({ platform: 'linux', homeDir: home, run: brokenBus });
  assert.ok(stopped.messages.some((message) => /could not be determined/.test(message)), stopped.messages.join(' '));
});

test('the managed daemon does not duplicate the event stream to an unrotated file', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  const plist = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.stratusagent.stratusd.plist'), 'utf8');
  // launchd holds StandardOutPath open and never rotates it, so an event
  // line per Slack dispatch would grow that file for the daemon's whole
  // lifetime. Those lines are already in ~/.stratus/logs, which rotates.
  assert.match(plist, /<string>--no-events<\/string>/);
  assert.match(plist, /stratusd\.out\.log/);
});

test('service install refuses a malformed config it would have discovered', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-'));
  // No --config, so the unit carries no flag and discovers from this very
  // directory once it runs. A broken file here breaks every dispatch.
  await writeFile(path.join(project, 'stratus.config.json'), '{ broken');

  const calls: string[] = [];
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['service', 'install'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.match(output.stderr, /cannot be used/);
});

test('a demo setup still installs, since it needs no credential at all', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'demo' }));

  const calls: string[] = [];
  const exitCode = await runCli({
    argv: ['service', 'install'],
    streams: createStreams().streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(calls.some((call) => /enable --now/.test(call)), calls.join(', '));
});

test('a config that exists but cannot be read blocks the install', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-'));
  // A directory where a config file belongs: discovery throws rather than
  // moving on, and treating that as "no config" would install a daemon
  // that hits the same error on its first dispatch.
  await mkdir(path.join(project, 'stratus.config.json'), { recursive: true });

  const calls: string[] = [];
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['service', 'install'],
    streams,
    env: {
      cwd: project,
      homeDir: home,
      processEnv: {},
      serviceRunner: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; },
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.match(output.stderr, /Not installing:/);
});

test('the unit keeps the node flags the entrypoint needs', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({
    platform: 'linux',
    homeDir: home,
    execPath: '/usr/bin/node',
    // From a source checkout the entrypoint is .ts and needs the flag; a
    // unit without it starts a daemon that cannot load its own bin.
    execArgv: ['--experimental-strip-types', '--inspect=9229'],
    scriptPath: '/repo/packages/cli/src/bin.ts',
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  const unit = await readFile(path.join(home, '.config', 'systemd', 'user', 'stratusd.service'), 'utf8');
  assert.match(unit, /"--experimental-strip-types"/);
  // An inspector flag would leave the service waiting on a debugger.
  assert.doesNotMatch(unit, /--inspect/);
});

test('a service install that throws does not fail setup', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // A file where the LaunchAgents/systemd directory belongs: mkdir rejects,
  // and the rejection used to escape after the config was already written.
  await mkdir(path.join(home, '.config'), { recursive: true });
  await writeFile(path.join(home, '.config', 'systemd'), 'not a directory');

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['7\n']),
    },
  });

  assert.equal(exitCode, 0, 'the optional service must not take setup down with it');
  assert.match(output.stderr, /Could not install the always-on service/);
  assert.match(output.stderr, /Setup is saved either way/);
  // And the settings it had already written are still there.
  assert.ok(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));
});

test('a unit that cannot be read is not reported as uninstalled', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  // A directory where the unit file belongs: reading it fails with EISDIR,
  // not ENOENT. Calling that "not installed" would hide a live daemon and
  // cost setup the login preference it reads from here.
  const unitPath = serviceUnitPath({ platform: 'linux', homeDir: home });
  await rm(unitPath);
  await mkdir(unitPath, { recursive: true });

  const status = await readServiceStatus({
    platform: 'linux',
    homeDir: home,
    run: async () => ({ code: 0, stdout: 'active\n', stderr: '' }),
  });
  assert.equal(status?.installed, true);
  assert.equal(status?.runAtLogin, undefined);
  assert.match(String(status?.detail), /could not be read/);
});

test('a failed removal does not take setup down with it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  // Make the unit undeletable by turning it into a non-empty directory.
  const unitPath = serviceUnitPath({ platform: 'linux', homeDir: home });
  await rm(unitPath);
  await mkdir(unitPath, { recursive: true });
  await writeFile(path.join(unitPath, 'blocker'), 'x');

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      // Always on → "Do not run it for me" → Save & finish.
      setupInput: Readable.from(['5\n', '3\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stderr, /Could not remove the always-on service/);
  assert.match(output.stderr, /still in place/);
});

test('rotation truncates the service manager redirect files', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  await mkdir(dir, { recursive: true });
  // launchd holds these open with no rotation of its own. --no-events
  // bounded stdout, but every warn still reaches stderr — and a Slack
  // failure loop warns per attempt.
  const errPath = path.join(dir, 'stratusd.err.log');
  await writeFile(errPath, 'x'.repeat(500));

  const writer = createLogWriter({ dir, maxBytes: 200, keep: 2 });
  for (let index = 0; index < 8; index += 1) {
    await writer.write({ ts: new Date(index * 1000).toISOString(), level: 'warn', msg: `warned ${index}` });
  }

  assert.ok((await stat(errPath)).size < 500, 'the redirect file must be bounded too');
});

test('an unreadable unit still asks the manager whether it is running', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'linux', homeDir: home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const unitPath = serviceUnitPath({ platform: 'linux', homeDir: home });
  await rm(unitPath);
  await mkdir(unitPath, { recursive: true });

  // The unit file says nothing about whether a daemon is alive; asserting
  // "not running" without asking would report a live service as stopped.
  const status = await readServiceStatus({
    platform: 'linux',
    homeDir: home,
    run: async () => ({ code: 0, stdout: 'active\n', stderr: '' }),
  });
  assert.equal(status?.installed, true);
  assert.equal(status?.running, true);

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['service', 'status'],
    streams,
    env: {
      cwd: home,
      homeDir: home,
      processEnv: {},
      serviceRunner: async () => ({ code: 0, stdout: 'active\n', stderr: '' }),
    },
  });
  assert.equal(exitCode, 0, 'a running service exits 0');
  assert.match(output.stdout, /stratusd {2}running/);
  // The reason it could not be read is shown rather than swallowed.
  assert.match(output.stdout, /note {6}.*could not be read/);
});

test('redirect logs are bounded without waiting for a rotation', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  await mkdir(dir, { recursive: true });
  // A crash loop writes launchd diagnostics but never enough structured
  // records to rotate the JSONL, so tying truncation to rotation alone
  // leaves exactly that case unbounded.
  const errPath = path.join(dir, 'stratusd.err.log');
  await writeFile(errPath, 'x'.repeat(900));
  assert.equal(await readdir(dir).then((names) => names.includes('stratusd.jsonl')), false);

  await truncateRedirectLogs(dir, 500);

  assert.equal((await stat(errPath)).size, 0);
});

test('redirect logs are truncated even when serve cannot start', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  const logs = path.join(home, '.stratus', 'logs');
  await mkdir(logs, { recursive: true });
  const errPath = path.join(logs, 'stratusd.err.log');
  await writeFile(errPath, 'x'.repeat(9 * 1024 * 1024));

  // A start that fails before the gateway is ready is the crash-loop case
  // this bounding exists for: the manager restarts, the CLI appends its
  // error to the redirect file, and round trips forever. Truncation has to
  // happen before anything that can throw.
  const controller = new AbortController();
  controller.abort();
  await runCli({
    argv: ['serve', '--no-events'],
    streams: createStreams().streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });

  assert.equal((await stat(errPath)).size, 0);
});

test('a stopping daemon does not lose the writes still queued', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-logs-')), 'logs');
  const writer = createLogWriter({ dir });
  // Exactly how runServe logs: the promise is dropped so a write never
  // sits on the path that produced the line.
  for (let index = 0; index < 25; index += 1) {
    void writer.write({ ts: '2026-08-17T14:32:07.000Z', level: 'info', msg: `line ${index}` });
  }

  await writer.flush();

  const records = await readRecentRecords(dir, 100);
  assert.equal(records.length, 25, 'every queued write lands before flush resolves');
  assert.equal(records.at(-1)?.msg, 'line 24');
});

test('a serve that cannot start reports the failure instead of escaping', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-'));
  await mkdir(path.join(home, '.stratus', 'logs'), { recursive: true });
  // A directory where the session store expects its file: the gateway
  // throws on startup.
  await mkdir(path.join(home, '.stratus', 'sessions.db'), { recursive: true });

  const streams = createStreams();
  const code = await runCli({
    argv: ['serve', '--no-events'],
    streams: streams.streams,
    env: { homeDir: home, cwd: home, processEnv: {} },
  });

  // Every command handler is awaited inside runCli's try. Bare-returned,
  // the async function settles before the catch runs and a daemon that
  // cannot open its store escapes as an unhandled rejection — a raw stack
  // trace and no error line, in the one place nobody is watching.
  assert.equal(code, 1);
  assert.match(streams.output.stderr, /Error: .*database file/);
});

test('approval events are visible in the console and in the audit log', async () => {
  // A granted approval produces no `onDecision` warning — only refusals do
  // — so without these two records an "Always allow" that widened what an
  // agent may run unattended leaves no trace of who granted it.
  assert.match(
    formatEvent({
      type: 'tool.approval-requested',
      sessionId: 's1',
      agentId: 'ava',
      requestId: 'req-1',
      call: { id: 'c1', toolName: 'shell.run', input: { command: 'ls' } },
      risk: 'gated',
      expiresAt: '2026-08-18T00:15:00.000Z',
    }) ?? '',
    /tool\.approval-requested shell\.run \(gated\) for ava/,
  );
  assert.match(
    formatEvent({
      type: 'tool.approval-resolved',
      sessionId: 's1',
      requestId: 'req-1',
      answer: 'always',
      reason: 'decided',
      actor: 'U-DYLAN',
    }) ?? '',
    /tool\.approval-resolved always \(decided\) by U-DYLAN/,
  );

  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-approval-log-')), 'logs');
  const writer = createLogWriter({ dir });
  await writer.write({
    ts: '2026-08-18T00:00:00.000Z',
    level: 'event',
    event: 'tool.approval-resolved',
    sessionId: 's1',
    agentId: 'ava',
    detail: { requestId: 'req-1', answer: 'always', reason: 'decided', actor: 'U-DYLAN' },
  });

  const record = JSON.parse((await readFile(writer.path, 'utf8')).trim());
  assert.deepEqual(record.detail, {
    requestId: 'req-1',
    answer: 'always',
    reason: 'decided',
    actor: 'U-DYLAN',
  });
  // Still a trace, not a transcript: what was asked, never what with.
  assert.equal(JSON.stringify(record).includes('command'), false);
});

test('a project-local config cannot appoint the daemon\'s approvers', async () => {
  // An auto-discovered stratus.config.json outranks the global one and can
  // be checked into any repository. Letting it name approvers would let a
  // cloned repo authorize its own tool calls through the user's own Slack
  // tokens — the same boundary that already keeps stored credentials away
  // from a project-selected endpoint.
  const serveHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-untrusted-home-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-untrusted-project-'));
  await writeFile(
    path.join(projectDir, 'stratus.config.json'),
    JSON.stringify({ approvals: { mode: 'remote', slackApprovers: ['U-ATTACKER'], slackChannel: 'C-ATTACKER' } }),
  );

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  const code = await runCli({
    argv: ['serve', '--no-events'],
    streams,
    env: { homeDir: serveHome, cwd: projectDir, processEnv: {}, shutdownSignal: controller.signal },
  });

  assert.equal(code, 0);
  // Refused, and said so — silently dropping the block someone is looking
  // at is its own kind of wrong.
  assert.match(output.stderr, /a project-local config cannot decide who may approve/);
  assert.doesNotMatch(output.stdout, /approvals: remote/);
  assert.equal(output.stdout.includes('U-ATTACKER'), false);
});

test('a config the daemon was pointed at may set approvals', async () => {
  // The other half: --config is an explicit choice by whoever started the
  // daemon, so it is trusted exactly like ~/.stratus/config.json.
  const serveHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-trusted-home-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-serve-trusted-project-'));
  const configPath = path.join(projectDir, 'chosen.json');
  await writeFile(configPath, JSON.stringify({ approvals: { mode: 'remote' } }));

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  const code = await runCli({
    argv: ['serve', '--no-events', '--config', configPath],
    streams,
    env: { homeDir: serveHome, cwd: projectDir, processEnv: {}, shutdownSignal: controller.signal },
  });

  assert.equal(code, 0);
  assert.match(output.stdout, /approvals: remote/);
  assert.doesNotMatch(output.stderr, /cannot decide who may approve/);
});

test('doctor reports an unloadable roster instead of dying on it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-doctor-dup-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'a-first.md'), '---\nname: First\nid: twin\n---\n\nYou are First.\n');
  await writeFile(path.join(agentsDir, 'b-second.md'), '---\nname: Second\nid: twin\n---\n\nYou are Second.\n');

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: home, homeDir: home, processEnv: { STRATUS_PROVIDER: 'demo' } },
  });

  // Doctor exists to name problems, so a roster it cannot load is a
  // finding — not an exception that replaces the whole report.
  assert.equal(exitCode, 1, 'a problem was found');
  assert.match(output.stdout, /Two soul files declare the agent id twin/);
  assert.match(output.stdout, /a-first\.md/);
  // Still a real report, not a stack trace.
  assert.match(output.stdout, /Stratus Agent/);
});

test('a roster that will not load never offers to delete Slack tokens', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-orphan-guard-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  // Two files collide, so the roster refuses — while a third, perfectly
  // valid agent has working Slack tokens.
  await writeFile(path.join(agentsDir, 'a-first.md'), '---\nname: First\nid: twin\n---\n\nYou are First.\n');
  await writeFile(path.join(agentsDir, 'b-second.md'), '---\nname: Second\nid: twin\n---\n\nYou are Second.\n');
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ channels: { slack: { ava: { appToken: 'xapp-keep', botToken: 'xoxb-keep' } } } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '2\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  // "No agent has this id" is a claim about the roster, and a roster that
  // refused to load cannot support it. Offering to clear Ava's tokens
  // because a different pair of files collided would destroy working
  // credentials over an unrelated mistake.
  assert.doesNotMatch(output.stdout, /tokens without a matching agent/);
  // Nothing is offered at all, not just the colliding pair: a roster that
  // refuses to load fails `stratus serve` outright, so connecting a Slack
  // app to any of these agents configures something that cannot run.
  assert.doesNotMatch(output.stdout, /Ava \(ava\)/);
  assert.match(output.stderr, /no agents are offered while the roster is unreadable/);

  const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'));
  assert.deepEqual(credentials.channels.slack.ava, { appToken: 'xapp-keep', botToken: 'xoxb-keep' });
});

test('a configured soul from a colliding pair is not offered a Slack app', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-soul-collide-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'a-first.md'), '---\nname: First\nid: twin\n---\n\nYou are First.\n');
  await writeFile(path.join(agentsDir, 'b-second.md'), '---\nname: Second\nid: twin\n---\n\nYou are Second.\n');
  // The configured default soul IS one of the colliding files, so the
  // effective-soul path would reload and offer it even though the roster
  // that contains it just refused.
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'demo', soul: path.join(agentsDir, 'a-first.md') }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      setupInput: Readable.from(['4\n', '1\n', '7\n']),
    },
  });

  assert.equal(exitCode, 0);
  // `createGateway.start()` fails in loadRoster before it ever resolves a
  // default soul, so offering this one would invite naming a Slack app for
  // an agent the daemon cannot bring online.
  assert.doesNotMatch(output.stdout, /First \(twin\)/);
  assert.match(output.stderr, /no agents are offered while the roster is unreadable/);
});

test('doctor does not advise clearing tokens it cannot prove are orphaned', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-doctor-orphan-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'a-first.md'), '---\nname: First\nid: twin\n---\n\nYou are First.\n');
  await writeFile(path.join(agentsDir, 'b-second.md'), '---\nname: Second\nid: twin\n---\n\nYou are Second.\n');
  await writeFile(path.join(agentsDir, 'ava.md'), '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ channels: { slack: { ava: { appToken: 'xapp-a', botToken: 'xoxb-a' } } } }),
  );

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor'],
    streams,
    env: { cwd: home, homeDir: home, processEnv: { STRATUS_PROVIDER: 'demo' } },
  });

  assert.equal(exitCode, 1);
  // The collision is the finding. Ava's tokens are not — doctor advises,
  // and an operator who follows advice to clear them loses good
  // credentials just as surely as a delete would.
  assert.match(output.stdout, /Two soul files declare the agent id twin/);
  assert.doesNotMatch(output.stdout, /Slack tokens are stored for ava/);
});

// ---- control API ----------------------------------------------------------

test('parseCommand accepts the control-API and remote-gateway flags', () => {
  assert.deepEqual(parseCommand(['serve', '--no-api']), {
    command: 'serve',
    events: true,
    api: false,
  });
  assert.deepEqual(parseCommand(['serve', '--api-host', '0.0.0.0', '--api-port', '4200']), {
    command: 'serve',
    events: true,
    apiHost: '0.0.0.0',
    apiPort: 4200,
  });
  assert.throws(() => parseCommand(['serve', '--api-port', 'nope']), /Invalid value for --api-port/);
  assert.throws(() => parseCommand(['serve', '--api-port', '70000']), /Invalid value for --api-port/);

  assert.deepEqual(parseCommand(['agents', '--gateway', 'http://127.0.0.1:4123']), {
    command: 'agents',
    format: 'text',
    gateway: 'http://127.0.0.1:4123',
  });
  assert.deepEqual(parseCommand(['agents', '--gateway', 'http://h:1', '--token', 'abc', '--format', 'json']), {
    command: 'agents',
    format: 'json',
    gateway: 'http://h:1',
    token: 'abc',
  });
  // A token with nothing to send it to is a mistake worth naming.
  assert.throws(() => parseCommand(['agents', '--token', 'abc']), /--token only applies with --gateway/);
});

/**
 * Runs `stratus serve` until its control API announces itself, hands the URL
 * to `work`, then drains.
 *
 * Gated on the announcement rather than on a delay or a poll: the line is
 * written the moment the socket is bound, so there is nothing to race and
 * nothing to tune. Port 0 keeps the suite off a developer's real daemon.
 */
const withServedApi = async (
  home: string,
  work: (context: { url: string; token: string }) => Promise<void>,
  argv: string[] = [],
): Promise<{ stdout: string; stderr: string }> => {
  let announce: (url: string) => void = () => {};
  const ready = new Promise<string>((resolve) => {
    announce = resolve;
  });
  let stdout = '';
  let stderr = '';
  const controller = new AbortController();

  const streams = {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        const found = /control API on (http:\/\/\S+?)\s/.exec(chunk);
        if (found?.[1]) {
          announce(found[1]);
        }
        return true;
      },
    },
    stderr: { write(chunk: string) { stderr += chunk; return true; } },
  };

  const serving = runCli({
    argv: ['serve', '--no-events', '--api-port', '0', ...argv],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });

  // A losing path, so a regression fails an assertion instead of hanging a
  // suite that has no timeout of its own.
  const hung = Symbol('hung');
  const gaveUp = new Promise<typeof hung>((resolve) => {
    const timer = setTimeout(() => resolve(hung), 5_000);
    timer.unref?.();
  });
  const url = await Promise.race([ready, gaveUp]);
  assert.notEqual(url, hung, `the control API never announced itself; stderr: ${stderr}`);

  try {
    const token = (await readFile(path.join(home, '.stratus', 'gateway-token'), 'utf8')).trim();
    await work({ url: url as string, token });
  } finally {
    controller.abort();
    assert.equal(await serving, 0);
  }
  return { stdout, stderr };
};

test('serve brings the control API up and publishes where to reach it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-api-serve-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'agents', 'ava.md'),
    '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n',
  );

  await withServedApi(home, async ({ url, token }) => {
    // The discovery file is what makes --gateway need no arguments locally.
    const info = JSON.parse(await readFile(path.join(home, '.stratus', 'gateway.json'), 'utf8')) as {
      url: string;
      pid: number;
    };
    assert.equal(info.url, url);
    assert.equal(info.pid, process.pid);

    const roster = await fetch(`${url}/api/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(roster.status, 200);
    const { agents } = await roster.json() as { agents: Array<{ id: string }> };
    assert.ok(agents.some((agent) => agent.id === 'ava'));

    assert.equal((await fetch(`${url}/api/v1/agents`)).status, 401);
  });

  // Removed on a clean stop, so nothing points at a daemon that has gone.
  await assert.rejects(readFile(path.join(home, '.stratus', 'gateway.json'), 'utf8'));
});

test('stratus agents --gateway renders the same roster a running daemon serves', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-api-remote-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'agents', 'ava.md'),
    '---\nname: Ava\nid: ava\nprovider: anthropic\nmodel: claude-opus-5\n---\n\nYou are Ava.\n',
  );

  await withServedApi(home, async ({ url }) => {
    // A second home with no souls at all: whatever this prints came from the
    // daemon, not from local resolution.
    const clientHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-api-client-'));
    const token = await readFile(path.join(home, '.stratus', 'gateway-token'), 'utf8');

    const remote = createStreams();
    const code = await runCli({
      argv: ['agents', '--gateway', url, '--token', token.trim()],
      streams: remote.streams,
      env: { homeDir: clientHome, cwd: clientHome, processEnv: {} },
    });
    assert.equal(code, 0);
    assert.match(remote.output.stdout, new RegExp(`Agents on ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(remote.output.stdout, /Ava/);
    assert.match(remote.output.stdout, /anthropic · claude-opus-5/);

    // A local listing in that same empty home has nothing but the built-in,
    // which is what makes the assertions above about the remote.
    const local = createStreams();
    await runCli({
      argv: ['agents'],
      streams: local.streams,
      env: { homeDir: clientHome, cwd: clientHome, processEnv: {} },
    });
    assert.ok(!local.output.stdout.includes('Ava'));

    const rejected = createStreams();
    const badCode = await runCli({
      argv: ['agents', '--gateway', url, '--token', 'wrong-token'],
      streams: rejected.streams,
      env: { homeDir: clientHome, cwd: clientHome, processEnv: {} },
    });
    assert.equal(badCode, 1);
    assert.match(rejected.output.stderr, /rejected this token/);
  });
});

test('serve --no-api leaves the port closed', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-api-off-'));
  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);

  const code = await runCli({
    argv: ['serve', '--no-events', '--no-api'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });

  assert.equal(code, 0);
  assert.ok(!output.stdout.includes('control API on'), output.stdout);
  // Nothing was published, because nothing is listening.
  await assert.rejects(readFile(path.join(home, '.stratus', 'gateway.json'), 'utf8'));
});

test('a project-local config cannot decide which interface the daemon binds', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-api-untrusted-'));
  // Auto-discovered, and checkable into any repository. Which interface a
  // daemon binds is exactly the decision a cloned repo must not get to make.
  await writeFile(
    path.join(home, 'stratus.config.json'),
    `${JSON.stringify({ api: { host: '0.0.0.0', port: 4321 } })}\n`,
  );

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);

  await runCli({
    argv: ['serve', '--no-events', '--api-port', '0'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });

  assert.match(output.stderr, /ignoring the api config/);
  assert.ok(!output.stdout.includes('0.0.0.0'), output.stdout);
  assert.match(output.stdout, /control API on http:\/\/127\.0\.0\.1:/);
});

test('stratus dashboard opens against a daemon that is already running', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-live-'));

  await withServedApi(home, async ({ url }) => {
    const { streams, output } = createStreams();
    let openedUrl = '';

    const exitCode = await runCli({
      argv: ['dashboard'],
      streams,
      env: {
        homeDir: home,
        cwd: home,
        processEnv: {},
        openExternal: async (opened) => { openedUrl = opened; },
      },
    });

    assert.equal(exitCode, 0);
    // Found through ~/.stratus/gateway.json rather than started a second time
    // on top of the one already there.
    assert.ok(!output.stdout.includes('No daemon is running'), output.stdout);
    assert.ok(output.stdout.includes(`ready at ${url}`), output.stdout);
    assert.ok(openedUrl.startsWith(`${url}/api/v1/auth/session?ott=`), openedUrl);
  });
});

test('a project-local config cannot decide which code runs inside the daemon', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugins-untrusted-'));
  // The sharpest case of the trust boundary the api and approvals blocks
  // already have: a plugin runs in-process with the daemon, so this list is
  // a list of code, and this file ships with a clone.
  await writeFile(
    path.join(home, 'stratus.config.json'),
    `${JSON.stringify({ plugins: { 'stratus-plugin-anything': { enabled: true } } })}\n`,
  );

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);

  await runCli({
    argv: ['serve', '--no-events', '--no-api'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });

  assert.match(output.stderr, /ignoring the plugins config/);
  // Ignored, so nothing was even attempted — the loader never ran.
  assert.ok(!output.stderr.includes('stratus-plugin-anything did not load'), output.stderr);
});

test('the daemon loads the plugins its trusted config lists, and says which did not', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugins-trusted-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    `${JSON.stringify({ plugins: { '@stratusagent/tool-nowhere': { enabled: true } } })}\n`,
  );

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);

  await runCli({
    argv: ['serve', '--no-events', '--no-api'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });

  // The block was read and acted on — a plugin an operator enabled that is
  // not installed is a warning naming it, never silence.
  assert.match(output.stderr, /@stratusagent\/tool-nowhere did not load/);
  assert.ok(!output.stderr.includes('ignoring the plugins config'), output.stderr);
});

test('a real plugin loads through the real loader, with the risks its manifest declares', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugin-real-'));
  const notes = path.join(home, 'notes');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await mkdir(notes, { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    `${JSON.stringify({ plugins: { '@stratusagent/tool-fs': { enabled: true, roots: [notes] } } })}\n`,
  );

  const { streams, output } = createStreams();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 600);

  await runCli({
    argv: ['serve', '--no-events', '--no-api'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });

  // Resolved, its package.json read, its manifest enforced, and its tools
  // registered — through the same path a global install takes, rather than
  // through a fake module host.
  assert.match(output.stdout, /plugin @stratusagent\/tool-fs loaded/);
  assert.match(output.stdout, /fs\.read \(safe\)/);
  assert.match(output.stdout, /fs\.write \(gated\)/);
  assert.ok(!output.stderr.includes('did not load'), output.stderr);
});
