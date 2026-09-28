import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGateway } from '../src/index.ts';

interface CapturedRequest {
  messages: Array<{ role: string; content: string | null }>;
}

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('an agent the daemon runs is told where its soul and workspace are, and that its soul reloads', async () => {
  // Kai, asked to reread his soul after an edit, said he had none: there
  // was no SOUL.md in his workspace. The daemon knows the real path and
  // that it re-reads the file on every dispatch, so it says both.
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-runtime-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    path.join(agentsDir, 'kai.md'),
    '---\nname: Kai\nprovider: openai\nmodel: model-a\ntools: []\n---\n\nYou are Kai.\n',
  );

  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return openAiText('ok');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  await gateway.dispatch({ sessionId: 'kai-1', agentId: 'kai', userMessage: 'reread your soul' });
  await gateway.stop();

  const systemText = (captured[0]?.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  assert.ok(
    systemText.includes(`is the file ${path.join(agentsDir, 'kai.md')}.`),
    `the soul path is missing from:\n${systemText}`,
  );
  assert.match(systemText, /Stratus reads it again before every turn/);
  assert.ok(
    systemText.includes(`is ${path.join(agentsDir, 'kai', 'workspace')}.`),
    `the workspace is missing from:\n${systemText}`,
  );
});

const systemTextOf = (request: CapturedRequest | undefined): string =>
  (request?.messages ?? []).filter((message) => message.role === 'system').map((message) => message.content).join('\n');

test('an existing session picks up a changed language on its next turn, with no restart', async () => {
  // Quinn's mitigation was a line in each live soul; the shared setting has
  // to reach conversations already under way the same way a soul edit does.
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-language-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const soulFile = path.join(agentsDir, 'kai.md');
  await writeFile(soulFile, '---\nname: Kai\nprovider: openai\nmodel: model-a\ntools: []\n---\n\nYou are Kai.\n');

  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return openAiText('ok');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'kai-lang', agentId: 'kai', userMessage: 'first' });
    assert.match(systemTextOf(captured[0]), /Write in American English \(en-US\)/);
    assert.match(systemTextOf(captured[0]), /The model configured to answer as you is model-a on openai\./);

    // The fleet's config says British English: the same session hears it.
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ language: 'en-GB' }));
    await gateway.dispatch({ sessionId: 'kai-lang', agentId: 'kai', userMessage: 'second' });
    assert.match(systemTextOf(captured[1]), /Write in British English \(en-GB\)/);

    // And the soul's own language outranks the fleet's.
    await writeFile(soulFile, '---\nname: Kai\nprovider: openai\nmodel: model-a\nlanguage: en-AU\ntools: []\n---\n\nYou are Kai.\n');
    await gateway.dispatch({ sessionId: 'kai-lang', agentId: 'kai', userMessage: 'third' });
    assert.match(systemTextOf(captured[2]), /Write in Australian English \(en-AU\)/);
  } finally {
    await gateway.stop();
  }
});

test('an agent whose default model failed is told the fallback is answering, on that turn and after', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-fallback-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'kai.md'), '---\nname: Kai\ntools: []\n---\n\nYou are Kai.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'model-a',
    baseUrl: 'https://api.openai.test/v1',
    fallbackProvider: 'openai',
    fallbackModel: 'model-b',
  }));

  const captured: Array<CapturedRequest & { model?: string }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest & { model?: string };
    captured.push(body);
    return body.model === 'model-a'
      ? new Response(JSON.stringify({ error: { message: 'model-a is down' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      : openAiText('ok');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'kai-fb', agentId: 'kai', userMessage: 'first' });
    const primary = captured.find((body) => body.model === 'model-a');
    const fallback = captured.find((body) => body.model === 'model-b');
    // The default was told it is the default; the fallback that took over
    // mid-turn was told it took over.
    assert.match(systemTextOf(primary), /is model-a on openai, with model-b on openai as its fallback\./);
    assert.doesNotMatch(systemTextOf(primary), /has switched to the fallback/);
    assert.match(systemTextOf(fallback), /This conversation has switched to the fallback, so model-b on openai is the one answering now\./);

    // The switch is sticky, and the next turn says so from the start.
    captured.length = 0;
    await gateway.dispatch({ sessionId: 'kai-fb', agentId: 'kai', userMessage: 'second' });
    assert.equal(captured.every((body) => body.model === 'model-b'), true);
    assert.match(systemTextOf(captured[0]), /has switched to the fallback, so model-b on openai is the one answering now/);
  } finally {
    await gateway.stop();
  }
});
