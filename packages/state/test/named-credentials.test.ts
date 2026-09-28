import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import {
  NamedCredentialExistsError,
  addNamedCredential,
  grantSoulCredential,
  namedCredentialSource,
  withSoulFileLock,
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

  assert.equal(await grantSoulCredential(soulFile, 'github.token', 'kai'), true);
  const soul = await readFile(soulFile, 'utf8');
  assert.match(soul, /^credentials:\n  - search\.apiKey\n  - github\.token$/m);
  assert.match(soul, /^language: en-GB$/m);
  assert.match(soul, /^tools:\n  - web\.\*$/m);
  assert.match(soul, /You are Kai\./);

  // Already granted: the file is left as it is.
  assert.equal(await grantSoulCredential(soulFile, 'github.token', 'kai'), false);
  assert.equal(await readFile(soulFile, 'utf8'), soul);
});

test('a grant refuses a soul that no longer belongs to the agent that asked', async () => {
  // Reassigned while a request waited: granting would hand the key to
  // whoever the file names now.
  const env = await newEnv();
  const soulFile = path.join(env.homeDir, 'kai.md');
  await writeFile(soulFile, '---\nname: Bea\nid: bea\n---\n\nYou are Bea.\n');
  await assert.rejects(grantSoulCredential(soulFile, 'github.token', 'kai'), /now declares agent bea, not kai, so nothing was granted/);
  assert.doesNotMatch(await readFile(soulFile, 'utf8'), /credentials/);
});

test('grants answered at once for one agent both land', async () => {
  const env = await newEnv();
  const soulFile = path.join(env.homeDir, 'kai.md');
  await writeFile(soulFile, '---\nname: Kai\nid: kai\n---\n\nYou are Kai.\n');
  await Promise.all([
    grantSoulCredential(soulFile, 'github.token', 'kai'),
    grantSoulCredential(soulFile, 'linear.apiKey', 'kai'),
    grantSoulCredential(soulFile, 'search.apiKey', 'kai'),
  ]);
  const soul = await readFile(soulFile, 'utf8');
  for (const name of ['github.token', 'linear.apiKey', 'search.apiKey']) {
    assert.ok(soul.includes(`  - ${name}`), `${name} was dropped:\n${soul}`);
  }
});

test('a symlinked soul keeps its link: the grant lands on the file it points at', async () => {
  const env = await newEnv();
  const real = path.join(env.homeDir, 'dotfiles-kai.md');
  const link = path.join(env.homeDir, 'kai.md');
  await writeFile(real, '---\nname: Kai\nid: kai\n---\n\nYou are Kai.\n');
  await symlink(real, link);
  assert.equal(await grantSoulCredential(link, 'github.token', 'kai'), true);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.match(await readFile(real, 'utf8'), /^credentials:\n  - github\.token$/m);
});

test('an add never replaces a key the daemon environment supplies, since any stored entry outranks it', async () => {
  const env = { ...(await newEnv()), processEnv: { GITHUB_TOKEN: 'from-the-environment' } };
  assert.equal(await namedCredentialSource(env, 'kai', 'GITHUB_TOKEN'), 'environment');
  await assert.rejects(
    addNamedCredential(env, { name: 'GITHUB_TOKEN', value: 'from-a-form' }),
    (error: unknown) => error instanceof NamedCredentialExistsError && /supplied by the daemon's environment/.test(error.message),
  );
  await assert.rejects(
    addNamedCredential(env, { name: 'GITHUB_TOKEN', value: 'from-a-form', agentId: 'kai' }),
    /would replace it for kai/,
  );
  assert.deepEqual(Object.keys((await loadNamedCredentials(env)).shared), []);
});

test('namedCredentialSource follows the resolver: the agent, then the fleet, then the environment', async () => {
  const env = { ...(await newEnv()), processEnv: { SEARCH_KEY: 'env' } };
  const named = await loadNamedCredentials(env);
  named.shared.SEARCH_KEY = 'shared';
  named.agents.kai = { SEARCH_KEY: 'own' };
  await saveNamedCredentials(env, named);
  assert.equal(await namedCredentialSource(env, 'kai', 'SEARCH_KEY'), 'agent');
  assert.equal(await namedCredentialSource(env, 'ava', 'SEARCH_KEY'), 'shared');
  assert.equal(await namedCredentialSource(env, 'ava', 'NOTHING'), undefined);
});

test('a grant waits for a soul edit that holds the lock, so neither write drops the other', async () => {
  // The control API's field edits hold this lock across their read and
  // write; a grant racing one would otherwise derive from the version the
  // edit was about to replace.
  const env = await newEnv();
  const soulFile = path.join(env.homeDir, 'kai.md');
  await writeFile(soulFile, '---\nname: Kai\nid: kai\n---\n\nYou are Kai.\n');
  let releaseEdit = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseEdit = resolve;
  });
  const edit = withSoulFileLock(async () => {
    const before = await readFile(soulFile, 'utf8');
    await gate;
    await writeFile(soulFile, before.replace('You are Kai.', 'You are Kai, edited.'));
  });
  const grant = grantSoulCredential(soulFile, 'github.token', 'kai');
  releaseEdit();
  await Promise.all([edit, grant]);
  const soul = await readFile(soulFile, 'utf8');
  assert.match(soul, /You are Kai, edited\./);
  assert.match(soul, /^credentials:\n  - github\.token$/m);
});
