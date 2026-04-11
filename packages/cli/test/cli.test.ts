import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
  });
});

test('parseCommand can read prompts from stdin', () => {
  assert.deepEqual(parseCommand(['run', '--stdin'], { stdin: 'inspect this tool' }), {
    command: 'run',
    prompt: 'inspect this tool',
    format: 'text',
    events: true,
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
  });
});

test('parseCommand accepts dashboard flags', () => {
  assert.deepEqual(parseCommand(['dashboard', '--port', '4123', '--host', '0.0.0.0', '--no-open']), {
    command: 'dashboard',
    port: 4123,
    host: '0.0.0.0',
    openBrowser: false,
  });
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
  assert.match(output.stdout, /\[tool:demo\.echo\]/);
  assert.match(output.stdout, /"uppercase": "PLEASE USE THE ECHO TOOL"/);
  assert.equal(output.stderr, '');
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
