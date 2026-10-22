import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSoul } from '@stratusagent/agents';
import type { Session } from '@stratusagent/core';

import { createRuntimeProvider, describeRuntimeEffort, resolveRuntimeConfig } from '../src/index.ts';

// A Claude subscription daemon with an Opus 4.6 fallback, the shape the
// fleet runs: the soul's effort has to reach the Agent SDK for both models,
// lowered for the one that lacks the level, and stay off every agent whose
// soul does not ask.
const subscriptionHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-effort-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-test' } }));
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5-5', fallbackModel: 'claude-opus-4-6' }),
  );
  return home;
};

const session = (agentId: string): Session => ({
  id: `${agentId}-session`,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** Records every query's options; the primary model fails so the fallback runs too. */
const recordingQuery = () => {
  const calls: Array<{ model?: string; effort?: string }> = [];
  const queryFn = ((params: { options?: { model?: string; effort?: string } }) => {
    const options = params.options ?? {};
    calls.push({ ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) });
    return (async function* () {
      if (options.model === 'claude-opus-5-5') {
        throw new Error('overloaded_error');
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
    })();
  }) as never;
  return { queryFn, calls };
};

test("a soul's effort reaches the SDK for the primary and the fallback, lowered where the model lacks it", async () => {
  const home = await subscriptionHome();
  const { queryFn, calls } = recordingQuery();
  const runtime = await resolveRuntimeConfig(
    { presetSoul: parseSoul('---\nname: Blair\nid: blair\neffort: xhigh\n---\n\nYou are Blair.\n') },
    { homeDir: home, cwd: home, processEnv: {}, queryFn },
  );
  assert.equal(runtime.provider === 'anthropic' && runtime.effort, 'xhigh');
  assert.equal(runtime.provider === 'anthropic' && runtime.fallback?.effort, 'xhigh');

  await createRuntimeProvider(runtime).generate({ session: session('blair') });
  assert.deepEqual(calls, [
    { model: 'claude-opus-5-5', effort: 'xhigh' },
    // Opus 4.6 has no xhigh: what is sent is what it takes.
    { model: 'claude-opus-4-6', effort: 'high' },
  ]);
  assert.equal(
    describeRuntimeEffort(runtime),
    'blair: effort xhigh on claude-opus-5-5 via Claude Code harness, from soul; fallback claude-opus-4-6: high (asked xhigh; claude-opus-4-6 has no xhigh)',
  );
});

test('an agent whose soul sets no effort sends none, on either model, and logs nothing', async () => {
  const home = await subscriptionHome();
  const { queryFn, calls } = recordingQuery();
  const runtime = await resolveRuntimeConfig(
    { presetSoul: parseSoul('---\nname: Nova\nid: nova\n---\n\nYou are Nova.\n') },
    { homeDir: home, cwd: home, processEnv: {}, queryFn },
  );
  assert.equal(runtime.provider === 'anthropic' && 'effort' in runtime, false);
  assert.equal(runtime.provider === 'anthropic' && runtime.fallback !== undefined && 'effort' in runtime.fallback, false);

  await createRuntimeProvider(runtime).generate({ session: session('nova') });
  assert.deepEqual(calls, [{ model: 'claude-opus-5-5' }, { model: 'claude-opus-4-6' }]);
  assert.equal(describeRuntimeEffort(runtime), undefined);
});

test('an effort on a provider that takes none is reported as not sent', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-effort-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({ openai: { type: 'api_key', value: 'sk-openai' } }));
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai', model: 'gpt-4o' }));
  const runtime = await resolveRuntimeConfig(
    { presetSoul: parseSoul('---\nname: Ava\nid: ava\neffort: high\n---\n\nYou are Ava.\n') },
    { homeDir: home, cwd: home, processEnv: {} },
  );
  assert.equal(describeRuntimeEffort(runtime), 'ava: effort not sent (asked high in soul; the openai provider takes no effort setting)');
});
