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
