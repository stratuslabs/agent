import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { newHome, startApi, writeSoul } from './harness.ts';

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 40, completion_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('GET /usage answers from the ledger, and carries the budget with where each limit stands', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ budget: { monthly: 1000, weights: { inputTokens: 0.5 } } }));
  const harness = await startApi({
    home,
    env: { processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => openAiText('hi')) as typeof fetch },
  });
  try {
    await harness.gateway.dispatch({ sessionId: 'u-1', agentId: 'ava', userMessage: 'hello' });
    const response = await harness.call('/api/v1/usage');
    assert.equal(response.status, 200);
    const body = await response.json() as {
      usage: Array<{ agentId: string; calls: number; inputTokens: number; outputTokens: number }>;
      budget: { limits: Array<{ scope: string; period: string; limit: number; spent: number; reached: boolean }> };
    };
    assert.deepEqual(body.usage.map(({ agentId, calls, inputTokens, outputTokens }) => ({ agentId, calls, inputTokens, outputTokens })), [
      { agentId: 'ava', calls: 1, inputTokens: 40, outputTokens: 2 },
    ]);
    assert.deepEqual(body.budget.limits.map(({ scope, period, limit, spent, reached }) => ({ scope, period, limit, spent, reached })), [
      { scope: 'home', period: 'monthly', limit: 1000, spent: 22, reached: false },
    ]);
    const bad = await harness.call('/api/v1/usage?since=yesterday-ish');
    assert.equal(bad.status, 400);
  } finally {
    await harness.stop();
  }
});

test('leases are granted, listed with their state, and revoked over the API, with who did each', async () => {
  const harness = await startApi();
  try {
    const granted = await harness.call('/api/v1/leases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'ava', credential: 'github.token', expiresIn: '2h', maxUses: 3, reason: 'incident 9', actor: 'ops' }),
    });
    assert.equal(granted.status, 200);
    const { lease } = await granted.json() as { lease: { id: string; state: string; grantedBy: string; maxUses: number } };
    assert.equal(lease.state, 'active');
    assert.equal(lease.grantedBy, 'api:ops');
    assert.equal(lease.maxUses, 3);

    const listed = await (await harness.call('/api/v1/leases?agent=ava')).json() as { leases: Array<{ id: string }> };
    assert.deepEqual(listed.leases.map((entry) => entry.id), [lease.id]);

    const revoked = await harness.call(`/api/v1/leases/${lease.id}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json() as { lease: { state: string; revokedBy: string } }).lease.state, 'revoked');
    const again = await harness.call(`/api/v1/leases/${lease.id}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(again.status, 404);

    const endless = await harness.call('/api/v1/leases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'ava', credential: 'github.token', reason: 'forever' }),
    });
    assert.equal(endless.status, 400);
    const noReason = await harness.call('/api/v1/leases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'ava', credential: 'github.token', expiresIn: '1h', reason: ' ' }),
    });
    assert.equal(noReason.status, 400);
    assert.match((await noReason.json() as { error: { message: string } }).error.message, /reason/);
  } finally {
    await harness.stop();
  }
});

test('the operator sets a budget over PUT /config, and the next call is judged by it', async () => {
  const harness = await startApi();
  try {
    const put = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { budget: { daily: 5000 }, leases: { credentials: ['github.token'] } } }),
    });
    assert.equal(put.status, 200, await put.clone().text());
    const round = await (await harness.call('/api/v1/config')).json() as { config: { budget?: object; leases?: object } };
    assert.deepEqual(round.config.budget, { daily: 5000 });
    assert.deepEqual(round.config.leases, { credentials: ['github.token'] });
    // GET then PUT of the same document keeps working with the blocks present.
    const again = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: round.config }),
    });
    assert.equal(again.status, 200);
    assert.equal((await harness.gateway.budget())?.limits[0]?.limit, 5000);
    const bad = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { budget: { daily: -1 } } }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await harness.stop();
  }
});
