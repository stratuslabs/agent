import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFileMemoryStore,
  HELP_TEXT,
  parseCommand,
  resolveRuntimeConfig,
  runCli,
  slackAppManifest,
  startDashboardServer,
} from '../src/index.ts';

const packageDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
// Isolated HOME so tests never read or write the real ~/.stratus.
const tempHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));

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

test('startDashboardServer serves the landing page and echo api', async () => {
  const dashboard = await startDashboardServer({ host: '127.0.0.1' });

  try {
    const pageResponse = await fetch(`${dashboard.url}/`);
    const pageHtml = await pageResponse.text();
    assert.equal(pageResponse.status, 200);
    assert.match(pageHtml, /Stratus Agent Dashboard/);
    assert.match(pageHtml, /POST \/api\/echo/);

    const echoResponse = await fetch(`${dashboard.url}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'local test' }),
    });
    const echoPayload = await echoResponse.json();

    assert.deepEqual(echoPayload, {
      ok: true,
      received: 'local test',
      uppercase: 'LOCAL TEST',
      length: 10,
    });
  } finally {
    await dashboard.close();
  }
});

test('runCli starts the dashboard, prints the URL, and opens the browser callback', async () => {
  const { streams, output } = createStreams();
  let openedUrl = '';

  const exitCode = await runCli({
    argv: ['dashboard', '--port', '0'],
    streams,
    env: {
      openExternal: async (url) => {
        openedUrl = url;
      },
      dashboardAutoShutdownMs: 25,
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Stratus Agent Dashboard ready at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(output.stdout, /Opened your default browser\./);
  assert.match(output.stdout, /Press Ctrl\+C to stop\./);
  assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(output.stderr, '');
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
      setupInput: Readable.from(['1\n', '1\n', '2\n', 'sk-ant-test-key\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '1\n', '1\n', 'sk-ant-oat-123\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '1\n', '2\n', 'bad-key\n', '6\n']),
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
      setupInput: Readable.from(['3\n', '1\n', 'Ava\n', 'Be kind and brief.\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '3\n', '5\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '3\n', '6\n']),
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
      setupInput: Readable.from(['6\n']),
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
      setupInput: Readable.from(['1\n', '3\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '1\n', '2\n', 'sk-ant-key\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '3\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '2\n', 'https://local.test/v1\n', 'sk-local\n', '6\n']),
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
      setupInput: Readable.from(['5\n', '6\n']),
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
      setupInput: Readable.from(['2\n', '1\n', '2\n', '6\n']),
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
      setupInput: Readable.from(['2\n', '1\n', '1\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '2\n', '\n', 'sk-openai\n', '6\n']),
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
      setupInput: Readable.from(['5\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '3\n', '6\n']),
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
        listRequests.push({ url: String(url), bearer: headers.authorization });
        return new Response(JSON.stringify({ data: [{ id: 'local-llama' }] }), { status: 200 });
      }) as typeof fetch,
      setupInput: Readable.from(['2\n', '1\n', '1\n', '6\n']),
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
      setupInput: Readable.from(['2\n', '1\n', '1\n', '6\n']),
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
      setupInput: Readable.from(['2\n', '1\n', '1\n', '6\n']),
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
      setupInput: Readable.from(['2\n', '1\n', '\n', '6\n']),
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
      setupInput: Readable.from(['5\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '1\n', '2\n', 'sk-proxy\n', '6\n']),
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
      setupInput: Readable.from(['5\n', '6\n']),
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
      setupInput: Readable.from(['1\n', '2\n', 'https://new.test/v1\n', 'bad-key\n', '6\n']),
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
      setupInput: Readable.from(['2\n', '1\n', '1\n', '6\n']),
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
      // Channels → Ava → paste both tokens → Back → Save & finish
      setupInput: Readable.from(['4\n', '1\n', 'xapp-tok\n', 'xoxb-tok\n', '2\n', '6\n']),
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
      setupInput: Readable.from(['4\n', '1\n', 'xapp-tok\n', 'xoxb-bad\n', '2\n', '6\n']),
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
      setupInput: Readable.from(['4\n', '1\n', 'xoxb-wrong-kind\n', '2\n', '6\n']),
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
      setupInput: Readable.from(['4\n', '1\n', '2\n', '2\n', '6\n']),
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
      setupInput: Readable.from(['4\n', '1\n', 'xapp-t\n', 'xoxb-t\n', '2\n', '6\n']),
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
      setupInput: Readable.from(['4\n', '3\n', '6\n']),
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
      setupInput: Readable.from(['4\n', '1\n', 'xapp-t\n', 'xoxb-t\n', '2\n', '6\n']),
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

test('the Channels menu drops duplicate roster ids the way the gateway does', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  // Two files, one id. The gateway keeps the first sorted file; offering
  // the other would name a Slack app for an agent that can never be
  // dispatched to, since credentials are keyed by the shared id.
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
      setupInput: Readable.from(['4\n', '2\n', '6\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /First \(twin\)/);
  assert.doesNotMatch(output.stdout, /Second \(twin\)/);
  assert.match(output.stderr, /duplicate agent id twin/);
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
      setupInput: Readable.from(['4\n', '2\n', '6\n']),
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
  assert.match(output.stdout, /anthropic Claude subscription \(Pro\/Max\)$/m);
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
