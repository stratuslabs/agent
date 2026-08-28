import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGateway } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-skills-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const writeSkill = async (home: string, id: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), contents);
};

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const openAiToolCall = (name: string, args: object): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const CODE_REVIEW = `---
name: Code Review
description: Use when reviewing a diff or a pull request.
---

# Code review

Lead with the verdict, then findings by severity.
`;

interface CapturedRequest {
  messages: Array<{ role: string; content: string | null }>;
  tools?: Array<{ function: { name: string } }>;
}

test('a soul with skills: gets the one-liner, the reader, and the body — end to end through the daemon', async () => {
  const home = await newHome();
  await writeSkill(home, 'code-review', CODE_REVIEW);
  // The tools list does NOT name skill.read: the reader rides on skills.
  await writeSoul(home, 'ava.md', [
    '---',
    'name: Ava',
    'provider: openai',
    'model: model-a',
    'tools:',
    '  - memory.remember',
    'skills:',
    '  - code-review',
    '---',
    '',
    'You review code.',
    '',
  ].join('\n'));

  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    captured.push(body);
    return captured.length === 1
      ? openAiToolCall('skill_read', { id: 'code-review' })
      : openAiText('reviewed');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();

  assert.deepEqual(gateway.skills().map((skill) => skill.id), ['code-review']);
  assert.ok(gateway.tools().some((tool) => tool.name === 'skill.read'));

  const session = await gateway.dispatch({ sessionId: 'review-1', agentId: 'ava', userMessage: 'review this' });
  await gateway.stop();

  // The system prompt carried the one-line description, never the body.
  const systemText = (captured[0]?.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  assert.match(systemText, /code-review \(Code Review\): Use when reviewing a diff or a pull request\./);
  assert.ok(!systemText.includes('Lead with the verdict'), 'the body leaked into the system prompt');

  // The reader was advertised without the soul's tools list naming it.
  assert.ok(captured[0]?.tools?.some((tool) => tool.function.name === 'skill_read'));

  // And the call came back with the body.
  const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
  assert.equal(result?.ok, true);
  assert.match(JSON.stringify(result?.output), /Lead with the verdict/);
});

test('a soul with no skills: key gets no skills — not every installed one', async () => {
  const home = await newHome();
  await writeSkill(home, 'code-review', CODE_REVIEW);
  await writeSoul(home, 'kai.md', '---\nname: Kai\nprovider: openai\nmodel: model-a\n---\n\nYou are Kai.\n');

  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return openAiText('hello');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  await gateway.dispatch({ sessionId: 'plain-1', agentId: 'kai', userMessage: 'hi' });
  await gateway.stop();

  const systemText = (captured[0]?.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  assert.ok(!systemText.includes('code-review'), 'an unenabled skill reached the prompt');
  assert.ok(
    !(captured[0]?.tools ?? []).some((tool) => tool.function.name === 'skill_read'),
    'an agent with no skills was shown the reader',
  );
});

test('enabling a skill whose requires: the tools list does not cover warns at load, never refuses', async () => {
  const home = await newHome();
  await writeSkill(home, 'site-audit', [
    '---',
    'description: Use when auditing a live site.',
    'requires:',
    '  - browser.*',
    '---',
    '',
    'Open the page and walk the flows.',
    '',
  ].join('\n'));
  await writeSoul(home, 'ava.md', [
    '---',
    'name: Ava',
    'provider: openai',
    'model: model-a',
    'tools:',
    '  - memory.remember',
    'skills:',
    '  - site-audit',
    '---',
    '',
    'You audit sites.',
    '',
  ].join('\n'));

  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: (line) => warnings.push(line) });
  await gateway.start();
  // Started and serving: the warning is advisory, the agent still loads.
  assert.ok(gateway.agents().some((agent) => agent.id === 'ava'));
  await gateway.stop();

  assert.ok(
    warnings.some((line) => line.includes('ava') && line.includes('site-audit') && line.includes('browser.*')),
    `expected a requires warning, got: ${warnings.join(' | ')}`,
  );
});
