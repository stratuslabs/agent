import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readFile, writeFile } from 'node:fs/promises';
import {
  NamedCredentialExistsError,
  addNamedCredential,
  grantSoulCredential,
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

test('the replacement command an add prints quotes an agent id a shell would split', async () => {
  // An agent id may hold a space or a `;`, and the refusal hands the reader
  // a command to copy: it must run what it says and nothing else.
  const env = await newEnv();
  await addNamedCredential(env, { name: 'github.token', value: 'first', agentId: 'ava;echo' });
  await assert.rejects(
    addNamedCredential(env, { name: 'github.token', value: 'second', agentId: 'ava;echo' }),
    (error: unknown) => error instanceof NamedCredentialExistsError
      && error.message.includes("stratus credential set github.token --agent 'ava;echo'."),
  );
});

test('granting a credential in a soul adds the name once and keeps everything else the soul says', async () => {
  const env = await newEnv();
  const soulFile = path.join(env.homeDir, 'kai.md');
  await writeFile(soulFile, '---\nname: Kai\nid: kai\nlanguage: en-GB\ntools: [web.*]\ncredentials: [search.apiKey]\n---\n\nYou are Kai.\n');

  assert.equal(await grantSoulCredential(soulFile, 'github.token'), true);
  const soul = await readFile(soulFile, 'utf8');
  assert.match(soul, /^credentials:\n  - search\.apiKey\n  - github\.token$/m);
  assert.match(soul, /^language: en-GB$/m);
  assert.match(soul, /^tools:\n  - web\.\*$/m);
  assert.match(soul, /You are Kai\./);

  // Already granted: the file is left as it is.
  assert.equal(await grantSoulCredential(soulFile, 'github.token'), false);
  assert.equal(await readFile(soulFile, 'utf8'), soul);
});
