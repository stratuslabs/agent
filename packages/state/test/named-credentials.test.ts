import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  NamedCredentialExistsError,
  addNamedCredential,
  loadNamedCredentials,
  saveNamedCredentials,
} from '../src/index.ts';

const newEnv = async (): Promise<{ homeDir: string }> => ({
  homeDir: await mkdtemp(path.join(os.tmpdir(), 'stratus-named-add-')),
});

test('an add stores a new shared or per-agent credential', async () => {
  const env = await newEnv();
  await addNamedCredential(env, { name: 'github.token', value: 'ghp-shared' });
  await addNamedCredential(env, { name: 'linear.apiKey', value: 'lin-kai', agentId: 'kai' });

  const named = await loadNamedCredentials(env);
  assert.equal(named.shared['github.token'], 'ghp-shared');
  assert.equal(named.agents.kai?.['linear.apiKey'], 'lin-kai');
});

test('an add never replaces a stored credential, and says how to on the machine', async () => {
  const env = await newEnv();
  await addNamedCredential(env, { name: 'github.token', value: 'ghp-original' });
  await addNamedCredential(env, { name: 'linear.apiKey', value: 'lin-original', agentId: 'kai' });

  await assert.rejects(
    addNamedCredential(env, { name: 'github.token', value: 'ghp-attacker' }),
    (error: unknown) => error instanceof NamedCredentialExistsError
      && /already stored/.test(error.message)
      && /stratus credential set github\.token/.test(error.message),
  );
  await assert.rejects(
    addNamedCredential(env, { name: 'linear.apiKey', value: 'lin-new', agentId: 'kai' }),
    (error: unknown) => error instanceof NamedCredentialExistsError && /--agent kai/.test(error.message),
  );
  // An agent's own entry is read before the shared one, so adding it over a
  // shared key would replace the key that agent's calls use.
  await assert.rejects(
    addNamedCredential(env, { name: 'github.token', value: 'ghp-kai', agentId: 'kai' }),
    (error: unknown) => error instanceof NamedCredentialExistsError && /would replace it for kai/.test(error.message),
  );

  const named = await loadNamedCredentials(env);
  assert.equal(named.shared['github.token'], 'ghp-original');
  assert.equal(named.agents.kai?.['linear.apiKey'], 'lin-original');
  assert.equal(named.agents.kai?.['github.token'], undefined);
});

test('a shared add is not blocked by one agent having its own', async () => {
  // Nothing is replaced: the agent with its own keeps reading it first, and
  // every other agent gains the shared one.
  const env = await newEnv();
  await addNamedCredential(env, { name: 'github.token', value: 'ghp-kai', agentId: 'kai' });
  await addNamedCredential(env, { name: 'github.token', value: 'ghp-shared' });

  const named = await loadNamedCredentials(env);
  assert.equal(named.agents.kai?.['github.token'], 'ghp-kai');
  assert.equal(named.shared['github.token'], 'ghp-shared');
});

test('two adds of one name racing inside a process cannot both land', async () => {
  const env = await newEnv();
  const results = await Promise.allSettled([
    addNamedCredential(env, { name: 'github.token', value: 'first' }),
    addNamedCredential(env, { name: 'github.token', value: 'second' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const refused = results.find((result) => result.status === 'rejected');
  assert.ok(refused?.status === 'rejected' && refused.reason instanceof NamedCredentialExistsError);
  assert.equal((await loadNamedCredentials(env)).shared['github.token'], 'first');
});

test('an add refuses a name no soul could list, an unsafe agent id, and an empty value', async () => {
  const env = await newEnv();
  await assert.rejects(addNamedCredential(env, { name: '__proto__', value: 'x' }), /not a credential name/);
  await assert.rejects(addNamedCredential(env, { name: 'github.token', value: 'x', agentId: '../kai' }), /cannot be an agent id/);
  await assert.rejects(addNamedCredential(env, { name: 'github.token', value: '   ' }), /empty/);
  assert.deepEqual(Object.keys((await loadNamedCredentials(env)).shared), []);
});

test('an add keeps every other named credential in the file', async () => {
  const env = await newEnv();
  const named = await loadNamedCredentials(env);
  named.shared['search.apiKey'] = 'search-1';
  await saveNamedCredentials(env, named);

  await addNamedCredential(env, { name: 'github.token', value: 'ghp-1' });

  const after = await loadNamedCredentials(env);
  assert.equal(after.shared['search.apiKey'], 'search-1');
  assert.equal(after.shared['github.token'], 'ghp-1');
});
