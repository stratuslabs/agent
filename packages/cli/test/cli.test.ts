import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  startDashboardServer,
} from '../src/index.ts';

const packageDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

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

test('runCli setup walks through an openai config and reports the missing key', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: tempDir,
      processEnv: {},
      setupInput: Readable.from(['2\n', '\n', 'https://example.test/v1\n', '\n', 'Be brief.\n']),
    },
  });

  assert.equal(exitCode, 0);

  const written = JSON.parse(await readFile(path.join(tempDir, 'stratus.config.json'), 'utf8'));
  assert.deepEqual(written, {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://example.test/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    systemPrompt: 'Be brief.',
  });

  assert.match(output.stdout, /Wrote .*stratus\.config\.json/);
  assert.match(output.stdout, /OPENAI_API_KEY is NOT set/);
  assert.match(output.stdout, /export OPENAI_API_KEY=your-key/);
  assert.equal(output.stderr, '');
});

test('runCli setup includes a custom config path in the suggested next commands', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup', '--config', './custom.json'],
    streams,
    env: {
      cwd: tempDir,
      processEnv: {},
      setupInput: Readable.from(['2\n', '\n', '\n', '\n', '\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /Wrote .*custom\.json/);
  assert.match(output.stdout, /stratus run --config \.\/custom\.json "say hello"/);
});

test('runCli setup shell-quotes config paths containing spaces in next commands', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup', '--config', './my config.json'],
    streams,
    env: {
      cwd: tempDir,
      processEnv: {},
      setupInput: Readable.from(['3\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /stratus run --config '\.\/my config\.json' "please use the echo tool"/);
});

test('runCli setup warns when an exported STRATUS_PROVIDER overrides the chosen provider', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: tempDir,
      processEnv: { STRATUS_PROVIDER: 'openai' },
      setupInput: Readable.from(['3\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /STRATUS_PROVIDER=openai is exported and takes precedence/);
  assert.match(output.stdout, /unset STRATUS_PROVIDER/);
  assert.match(output.stdout, /stratus run --provider demo "please use the echo tool"/);

  const clean = createStreams();
  await runCli({
    argv: ['setup'],
    streams: clean.streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      processEnv: {},
      setupInput: Readable.from(['3\n']),
    },
  });
  assert.doesNotMatch(clean.output.stdout, /--provider/);
});

test('runCli setup writes to the STRATUS_CONFIG path that run will load', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const envConfigPath = path.join(tempDir, 'nested', '..', 'env-config.json');
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: tempDir,
      processEnv: { STRATUS_CONFIG: envConfigPath },
      setupInput: Readable.from(['3\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /STRATUS_CONFIG is set, so the config will be written to/);
  const written = JSON.parse(await readFile(path.join(tempDir, 'env-config.json'), 'utf8'));
  assert.deepEqual(written, { provider: 'demo' });
  assert.doesNotMatch(output.stdout, /stratus run --config/);
});

test('runCli setup warns when exported model or base-url overrides the configured values', async () => {
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      processEnv: {
        STRATUS_MODEL: 'gpt-old',
        STRATUS_BASE_URL: 'https://old.example.test/v1',
        OPENAI_API_KEY: 'set-key',
      },
      setupInput: Readable.from(['2\n', 'gpt-4.1-mini\n', 'https://new.example.test/v1\n', '\n', '\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /STRATUS_MODEL=gpt-old is exported and takes precedence/);
  assert.match(output.stdout, /STRATUS_BASE_URL=https:\/\/old\.example\.test\/v1 is exported and takes precedence/);
  assert.match(output.stdout, /stratus run --model gpt-4\.1-mini --base-url https:\/\/new\.example\.test\/v1 "say hello"/);
});

test('runCli setup warns when an exported system prompt overrides the configured one', async () => {
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      processEnv: { STRATUS_SYSTEM_PROMPT: 'Old env prompt.', OPENAI_API_KEY: 'set-key' },
      setupInput: Readable.from(['2\n', '\n', '\n', '\n', 'New configured prompt.\n']),
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /STRATUS_SYSTEM_PROMPT=Old env prompt\. is exported and takes precedence/);
  assert.match(output.stdout, /unset STRATUS_SYSTEM_PROMPT/);
  assert.doesNotMatch(output.stdout, /--system-prompt/);
});

test('runCli setup bases the key readiness check on exported API key overrides', async () => {
  const redirected = createStreams();
  const redirectedExit = await runCli({
    argv: ['setup'],
    streams: redirected.streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      processEnv: { STRATUS_API_KEY_ENV: 'MY_KEY', OPENAI_API_KEY: 'set-but-ignored' },
      setupInput: Readable.from(['2\n', '\n', '\n', '\n', '\n']),
    },
  });

  assert.equal(redirectedExit, 0);
  assert.match(redirected.output.stdout, /STRATUS_API_KEY_ENV=MY_KEY is exported and takes precedence/);
  assert.match(redirected.output.stdout, /MY_KEY is NOT set/);
  assert.match(redirected.output.stdout, /export MY_KEY=your-key/);
  assert.doesNotMatch(redirected.output.stdout, /OPENAI_API_KEY is set in your environment/);

  const directKey = createStreams();
  const directKeyExit = await runCli({
    argv: ['setup'],
    streams: directKey.streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      processEnv: { STRATUS_API_KEY: 'direct-key' },
      setupInput: Readable.from(['2\n', '\n', '\n', '\n', '\n']),
    },
  });

  assert.equal(directKeyExit, 0);
  assert.match(directKey.output.stdout, /STRATUS_API_KEY is set in your environment — you are ready to go/);
});

test('runCli setup writes a demo config without asking provider questions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: tempDir,
      processEnv: {},
      setupInput: Readable.from(['3\n']),
    },
  });

  assert.equal(exitCode, 0);
  const written = JSON.parse(await readFile(path.join(tempDir, 'stratus.config.json'), 'utf8'));
  assert.deepEqual(written, { provider: 'demo' });
  assert.match(output.stdout, /no API key needed/);
});

test('runCli setup refuses to overwrite an existing config unless confirmed', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const configPath = path.join(tempDir, 'stratus.config.json');
  await writeFile(configPath, JSON.stringify({ provider: 'demo' }));

  const declined = createStreams();
  const declinedExit = await runCli({
    argv: ['setup'],
    streams: declined.streams,
    env: {
      cwd: tempDir,
      processEnv: {},
      setupInput: Readable.from(['n\n']),
    },
  });

  assert.equal(declinedExit, 0);
  assert.match(declined.output.stdout, /Keeping the existing config/);
  assert.equal(await readFile(configPath, 'utf8'), JSON.stringify({ provider: 'demo' }));

  const accepted = createStreams();
  const acceptedExit = await runCli({
    argv: ['setup'],
    streams: accepted.streams,
    env: {
      cwd: tempDir,
      processEnv: { OPENAI_API_KEY: 'already-set' },
      setupInput: Readable.from(['y\n', '2\n', '\n', '\n', '\n', '\n']),
    },
  });

  assert.equal(acceptedExit, 0);
  const rewritten = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(rewritten.provider, 'openai');
  assert.match(accepted.output.stdout, /OPENAI_API_KEY is set in your environment/);
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
    processEnv: {
      CUSTOM_OPENAI_KEY: 'config-key',
    },
  });

  assert.deepEqual(runtime, {
    provider: 'openai',
    apiKey: 'config-key',
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
    env: { processEnv: {} },
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

test('runCli setup walks through an anthropic config without a base URL question', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-'));
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: tempDir,
      processEnv: {},
      setupInput: Readable.from(['1\n', '\n', '\n', '\n']),
    },
  });

  assert.equal(exitCode, 0);

  const written = JSON.parse(await readFile(path.join(tempDir, 'stratus.config.json'), 'utf8'));
  assert.deepEqual(written, {
    provider: 'anthropic',
    model: 'claude-opus-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  });

  assert.doesNotMatch(output.stdout, /Base URL/);
  assert.match(output.stdout, /ANTHROPIC_API_KEY is NOT set/);
  assert.match(output.stdout, /export ANTHROPIC_API_KEY=your-key/);
  assert.equal(output.stderr, '');
});

test('resolveRuntimeConfig defaults anthropic to claude-opus-5 and its own key env', async () => {
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: 'hello',
    provider: 'anthropic',
    format: 'text',
    events: true,
  }, {
    processEnv: {
      ANTHROPIC_API_KEY: 'env-key',
    },
  });

  assert.deepEqual(runtime, {
    provider: 'anthropic',
    apiKey: 'env-key',
    model: 'claude-opus-5',
  });

  await assert.rejects(
    () => resolveRuntimeConfig({
      command: 'run',
      prompt: 'hello',
      provider: 'anthropic',
      format: 'text',
      events: true,
    }, { processEnv: {} }),
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
    env: { cwd: tempDir, processEnv: {} },
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
    env: { cwd: tempDir, processEnv: {} },
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
    model: 'claude-opus-5',
  });
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
  const stored = (await readFile(path.join(tempDir, '.stratus', 'memory.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].agentId, 'anthropic-agent');
  assert.equal(stored[0].content, 'The user prefers short answers.');

  // A brand-new run — new session, same working directory — sees the memory.
  const secondRun = await runCli({
    argv: ['run', '--prompt', 'hi again', '--provider', 'anthropic'],
    streams: createStreams().streams,
    env: {
      cwd: tempDir,
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
  }, { cwd: tempDir, processEnv: {} });

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
    processEnv: { ANTHROPIC_API_KEY: 'anthropic-key', CUSTOM_OPENAI_KEY: 'openai-key' },
  });

  assert.deepEqual(anthropicRuntime, {
    provider: 'anthropic',
    apiKey: 'anthropic-key',
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
    processEnv: { CUSTOM_OPENAI_KEY: 'openai-key' },
  });

  assert.deepEqual(openaiRuntime, {
    provider: 'openai',
    apiKey: 'openai-key',
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
