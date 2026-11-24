import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { startApi } from './harness.ts';

// `DELETE /credentials/:provider`: the shared sign-in goes, and nothing else
// in the credentials file moves.

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const put = (call: (pathname: string, init?: RequestInit) => Promise<Response>, pathname: string, body: object): Promise<Response> =>
  call(pathname, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('DELETE /credentials/:provider removes that sign-in and leaves the others, the channels and agents\' own alone', async () => {
  const harness = await startApi();
  try {
    assert.equal((await put(harness.call, '/api/v1/credentials/anthropic', { type: 'api_key', value: 'sk-ant-keep-me-out' })).status, 200);
    assert.equal((await put(harness.call, '/api/v1/credentials/openai', { type: 'api_key', value: 'sk-openai-stays' })).status, 200);
    assert.equal((await put(harness.call, '/api/v1/credentials/channels/slack', { agentId: 'stratus', appToken: 'xapp-stays', botToken: 'xoxb-stays' })).status, 200);
    const file = path.join(harness.home, '.stratus', 'credentials.json');
    const before = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    // One more namespace the route must not touch, written as `stratus signin` writes it.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify({ ...before, agentSignIns: { stratus: { anthropic: { type: 'oauth_token', value: 'sk-ant-oat-own' } } } }));

    const removed = await harness.call('/api/v1/credentials/anthropic', { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await json(removed), { provider: 'anthropic', stored: false });

    const listed = await json<{ providers: Array<{ provider: string; stored: boolean }>; channels: { slack: string[] } }>(
      await harness.call('/api/v1/credentials'),
    );
    assert.equal(listed.providers.find((entry) => entry.provider === 'anthropic')?.stored, false);
    assert.equal(listed.providers.find((entry) => entry.provider === 'openai')?.stored, true);
    assert.deepEqual(listed.channels.slack, ['stratus']);

    const after = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(after.anthropic, undefined);
    assert.deepEqual(after.openai, before.openai);
    assert.deepEqual(after.channels, before.channels);
    assert.deepEqual(after.agentSignIns, { stratus: { anthropic: { type: 'oauth_token', value: 'sk-ant-oat-own' } } });
    // Removing is no reason to echo anything back.
    assert.ok(!JSON.stringify(await json(await harness.call('/api/v1/credentials'))).includes('sk-'));
  } finally {
    await harness.stop();
  }
});

test('removing a sign-in that is not stored is a 404, and only the three providers are names here', async () => {
  const harness = await startApi();
  try {
    const missing = await harness.call('/api/v1/credentials/codex', { method: 'DELETE' });
    assert.equal(missing.status, 404);
    assert.equal((await json<{ error: { code: string } }>(missing)).error.code, 'credential_not_found');

    const notAProvider = await harness.call('/api/v1/credentials/named', { method: 'DELETE' });
    assert.equal(notAProvider.status, 400);
    assert.equal((await json<{ error: { code: string } }>(notAProvider)).error.code, 'unknown_provider');
  } finally {
    await harness.stop();
  }
});
