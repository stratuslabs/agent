import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StratusEvent } from '@stratusagent/core';
import { createGateway } from '../src/index.ts';

// Synthetic values only, each distinct so a leak names its source.
const NAMED = 'synthetic-named-credential-1234';
const OTHER_AGENT = 'synthetic-other-agent-credential';
const SLACK_BOT = 'xoxb-synthetic-bot-token-5678';
const TRANSPORT = 'synthetic-photon-project-secret';
const FROM_ENV = 'synthetic-env-supplied-credential';

test('a provider failure that quotes stored secrets reaches the record, the event and the caller masked', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-failure-secrets-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'agents', 'ava.md'),
    '---\nname: Ava\nprovider: openai\nmodel: model-a\ncredentials: [search.apiKey, linear.apiKey]\n---\n\nYou are Ava.\n',
  );
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    named: { agents: { ava: { 'search.apiKey': NAMED }, kai: { 'github.token': OTHER_AGENT } } },
    channels: {
      slack: { ava: { appToken: 'xapp-synthetic-app-token', botToken: SLACK_BOT } },
      'imessage-photon': { ava: { projectSecret: TRANSPORT } },
    },
  }), { mode: 0o600 });

  // An endpoint whose error quotes everything it could plausibly have seen:
  // a header it was sent, another agent's key, the transport's tokens, and
  // a credential the environment supplies (in no file at all).
  const quoted = `bad request: ${NAMED} ${OTHER_AGENT} ${SLACK_BOT} ${TRANSPORT} ${FROM_ENV}`;
  const fetchImpl = (async () => new Response(
    JSON.stringify({ error: { message: quoted } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-test', 'linear.apiKey': FROM_ENV },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env });
  const failures: Array<Extract<StratusEvent, { type: 'session.failed' }>> = [];
  gateway.bus.subscribe((event) => {
    if (event.type === 'session.failed') {
      failures.push(event);
    }
  });
  await gateway.start();

  const masked = 'bad request: [redacted] [redacted] [redacted] [redacted] [redacted]';
  try {
    // What a channel's own failure line is built from.
    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'masked-1', agentId: 'ava', userMessage: 'hello' }),
      (error: Error) => error.message === masked,
    );
    // What the daemon log and `stratus logs` record, and what a channel
    // that did not start the turn posts.
    assert.deepEqual(failures.map((event) => event.error), [masked]);
    // What the session record keeps.
    assert.equal((await gateway.store.get('masked-1'))?.lastError, masked);
  } finally {
    await gateway.stop();
  }
});
