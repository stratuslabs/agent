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

test('a grant\'s check runs under the soul lock, after an edit holding it, and refuses by throwing', async () => {
  // The gateway's served-path check lives here so a roster reload, which
  // takes the same lock, cannot repoint the agent between check and write.
  const env = await newEnv();
  const soulFile = path.join(env.homeDir, 'kai.md');
  await writeFile(soulFile, '---\nname: Kai\nid: kai\n---\n\nYou are Kai.\n');
  let releaseEdit = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseEdit = resolve;
  });
  let edited = false;
  const edit = withSoulFileLock(async () => {
    await gate;
    edited = true;
  });
  let sawEdit: boolean | undefined;
  const grant = grantSoulCredential(soulFile, 'github.token', 'kai', {
    check: () => {
      sawEdit = edited;
      throw new Error('kai is now served from elsewhere');
    },
  });
  releaseEdit();
  await edit;
  await assert.rejects(grant, /kai is now served from elsewhere/);
  assert.equal(sawEdit, true, 'the check ran once the edit holding the lock was done');
  assert.doesNotMatch(await readFile(soulFile, 'utf8'), /credentials/);
});

test('replace swaps a stored value in place and never creates one', async () => {
  const { addNamedCredential, replaceNamedCredential, loadNamedCredentials, NamedCredentialMissingError } = await import('../src/index.ts');
  const env = await newEnv();
  await addNamedCredential(env, { name: 'github.token', value: 'ghp-old', agentId: 'kai' });
  await addNamedCredential(env, { name: 'search.apiKey', value: 'sk-old' });

  await replaceNamedCredential(env, { name: 'github.token', value: 'ghp-new', agentId: 'kai' });
  await replaceNamedCredential(env, { name: 'search.apiKey', value: 'sk-new' });
  let named = await loadNamedCredentials(env);
  assert.equal(named.agents.kai?.['github.token'], 'ghp-new');
  assert.equal(named.shared['search.apiKey'], 'sk-new');

  // Nothing there to replace: refused, and nothing is created. An agent's
  // own entry over a shared one would be an add under another name.
  for (const entry of [
    { name: 'npm.token', value: 'x', agentId: 'kai' },
    { name: 'npm.token', value: 'x' },
    { name: 'search.apiKey', value: 'x', agentId: 'kai' },
    { name: 'github.token', value: 'x', agentId: 'ava' },
  ]) {
    await assert.rejects(replaceNamedCredential(env, entry), NamedCredentialMissingError, JSON.stringify(entry));
  }
  // An empty value keeps the stored one.
  await assert.rejects(replaceNamedCredential(env, { name: 'github.token', value: '  ', agentId: 'kai' }), /empty, so the stored one was kept/);
  named = await loadNamedCredentials(env);
  assert.equal(named.agents.kai?.['github.token'], 'ghp-new');
  assert.equal(named.agents.kai?.['npm.token'], undefined);
  assert.equal(named.agents.ava, undefined);
  assert.equal(named.shared['npm.token'], undefined);
});

test('the credential audit log is one owner-only JSON line per change, names only', async () => {
  const { appendCredentialAudit, credentialAuditPath } = await import('../src/index.ts');
  const env = await newEnv();
  await appendCredentialAudit(env, { action: 'replace', name: 'github.token', agentId: 'kai', actor: 'U1', via: 'form', requestedBy: 'kai' });
  await appendCredentialAudit(env, { action: 'add', name: 'search.apiKey', via: 'link', requestedBy: 'ava' });
  const lines = (await readFile(credentialAuditPath(env), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
  assert.deepEqual(lines.map(({ at: _at, ...rest }) => rest), [
    { action: 'replace', name: 'github.token', store: 'agent:kai', actor: 'U1', via: 'form', requestedBy: 'kai' },
    { action: 'add', name: 'search.apiKey', store: 'shared', via: 'link', requestedBy: 'ava' },
  ]);
  assert.equal((await lstat(credentialAuditPath(env))).mode & 0o777, 0o600);
});

test('an add with a binding stores the value and the variable in one write, and the resolver reads both on every call', async () => {
  const { createFileCredentialResolver, credentialsPath } = await import('../src/index.ts');
  const env = await newEnv();
  // Built before anything is stored, as a daemon's is.
  const resolver = createFileCredentialResolver(env, {});
  const atlas = { id: 'atlas', name: 'Atlas', credentials: ['twilio.authToken', 'twilio.accountSid'] };
  assert.deepEqual({ ...await resolver.envBindings!(atlas) }, {});

  await addNamedCredential(env, { name: 'twilio.authToken', value: 'tw-secret', agentId: 'atlas', bind: { agentId: 'atlas', variable: 'TWILIO_AUTH_TOKEN' } });
  const file = JSON.parse(await readFile(credentialsPath(env), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(file.envBindings, { agents: { atlas: { TWILIO_AUTH_TOKEN: 'twilio.authToken' } } });
  assert.deepEqual({ ...await resolver.envBindings!(atlas) }, { TWILIO_AUTH_TOKEN: 'tw-secret' });

  // A soul that no longer lists the name gets nothing from its binding.
  assert.deepEqual({ ...await resolver.envBindings!({ ...atlas, credentials: [] }) }, {});
  // Another agent never gets atlas's bindings.
  assert.deepEqual({ ...await resolver.envBindings!({ ...atlas, id: 'kai' }) }, {});
});

test('a binding on a shared key is for the one agent that was approved, and an env-supplied key can be bound on the machine', async () => {
  const { bindCredentialEnv, createFileCredentialResolver } = await import('../src/index.ts');
  const env = await newEnv();
  await addNamedCredential(env, { name: 'github.token', value: 'ghp-shared', bind: { agentId: 'atlas', variable: 'GH_TOKEN' } });
  const resolver = createFileCredentialResolver(env, { OPENAI_KEY_FROM_ENV: 'sk-env' });
  const granted = ['github.token', 'OPENAI_KEY_FROM_ENV'];
  assert.deepEqual({ ...await resolver.envBindings!({ id: 'atlas', name: 'Atlas', credentials: granted }) }, { GH_TOKEN: 'ghp-shared' });
  // Kai is granted the shared key too, but nobody bound it for kai's shell.
  assert.deepEqual({ ...await resolver.envBindings!({ id: 'kai', name: 'Kai', credentials: granted }) }, {});

  // Docker -e / fly secrets: the value is in the environment, bound by name.
  assert.equal(await bindCredentialEnv(env, { agentId: 'kai', variable: 'OPENAI_API_KEY', name: 'OPENAI_KEY_FROM_ENV' }), undefined);
  assert.deepEqual({ ...await resolver.envBindings!({ id: 'kai', name: 'Kai', credentials: granted }) }, { OPENAI_API_KEY: 'sk-env' });
});

test('bind and unbind refuse a variable that changes how commands run, and report what a variable was bound to', async () => {
  const { bindCredentialEnv, unbindCredentialEnv, loadCredentialEnvBindings } = await import('../src/index.ts');
  const env = await newEnv();
  for (const variable of ['PATH', 'BASH_ENV', 'GIT_DIR', 'GREP_OPTIONS', 'BASH_FUNC_x%%', '1BAD']) {
    await assert.rejects(bindCredentialEnv(env, { agentId: 'atlas', variable, name: 'github.token' }), Error, variable);
    await assert.rejects(
      addNamedCredential(env, { name: 'github.token', value: 'x', bind: { agentId: 'atlas', variable } }),
      Error,
      variable,
    );
  }
  // Refused before anything was written.
  assert.deepEqual({ ...await loadNamedCredentials(env) }.shared, Object.create(null));
  await assert.rejects(bindCredentialEnv(env, { agentId: '__proto__', variable: 'GH_TOKEN', name: 'github.token' }), /cannot be an agent id/);

  // The operator's rule only: not secret-shaped is the operator's call.
  assert.equal(await bindCredentialEnv(env, { agentId: 'atlas', variable: 'DATABASE_URL', name: 'db.url' }), undefined);
  assert.equal(await bindCredentialEnv(env, { agentId: 'atlas', variable: 'DATABASE_URL', name: 'db.replica' }), 'db.url');
  assert.equal(await unbindCredentialEnv(env, { agentId: 'atlas', variable: 'DATABASE_URL' }), 'db.replica');
  assert.equal(await unbindCredentialEnv(env, { agentId: 'atlas', variable: 'DATABASE_URL' }), undefined);
  assert.deepEqual({ ...await loadCredentialEnvBindings(env) }, {});
});

test('removing a credential takes the bindings that read it, and nothing else', async () => {
  const { bindCredentialEnv, loadCredentialEnvBindings, removeNamedCredential } = await import('../src/index.ts');
  const env = await newEnv();
  // As `stratus credential set` leaves it: a shared key, and kai's own over it.
  await saveNamedCredentials(env, { shared: { 'github.token': 'ghp-shared' }, agents: { kai: { 'github.token': 'ghp-kai' } } });
  await bindCredentialEnv(env, { agentId: 'atlas', variable: 'GH_TOKEN', name: 'github.token' });
  await bindCredentialEnv(env, { agentId: 'kai', variable: 'GH_TOKEN', name: 'github.token' });
  await bindCredentialEnv(env, { agentId: 'atlas', variable: 'NPM_TOKEN', name: 'npm.token' });

  // Kai's own key goes, and kai's binding of it with it; atlas's binding
  // reads the shared key and stays.
  assert.equal(await removeNamedCredential(env, { name: 'github.token', agentId: 'kai' }), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await loadCredentialEnvBindings(env))),
    { atlas: { GH_TOKEN: 'github.token', NPM_TOKEN: 'npm.token' } },
  );
  // The shared one goes, and so does every binding that read it.
  assert.equal(await removeNamedCredential(env, { name: 'github.token' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(await loadCredentialEnvBindings(env))), { atlas: { NPM_TOKEN: 'npm.token' } });
  assert.equal(await removeNamedCredential(env, { name: 'github.token' }), false);
});

test('writers that predate bindings keep the block, and anything a newer daemon put beside it', async () => {
  const { bindCredentialEnv, credentialsPath, saveCredentials, loadCredentialEnvBindings } = await import('../src/index.ts');
  const env = await newEnv();
  await bindCredentialEnv(env, { agentId: 'atlas', variable: 'GH_TOKEN', name: 'github.token' });
  const file = JSON.parse(await readFile(credentialsPath(env), 'utf8')) as Record<string, Record<string, unknown>>;
  file.envBindings!.fleet = { FUTURE_TOKEN: 'future.token' };
  await writeFile(credentialsPath(env), JSON.stringify(file));

  await saveNamedCredentials(env, { shared: { 'search.apiKey': 'sk' }, agents: {} });
  await saveCredentials(env, { anthropic: { type: 'api_key', value: 'sk-ant' } });
  await bindCredentialEnv(env, { agentId: 'kai', variable: 'NPM_TOKEN', name: 'npm.token' });

  const after = JSON.parse(await readFile(credentialsPath(env), 'utf8')) as Record<string, Record<string, unknown>>;
  assert.deepEqual(after.envBindings!.fleet, { FUTURE_TOKEN: 'future.token' });
  assert.deepEqual(JSON.parse(JSON.stringify(await loadCredentialEnvBindings(env))), {
    atlas: { GH_TOKEN: 'github.token' },
    kai: { NPM_TOKEN: 'npm.token' },
  });
});

test('the audit line for a binding names the variable and whose shell it is for', async () => {
  const { appendCredentialAudit, credentialAuditPath } = await import('../src/index.ts');
  const env = await newEnv();
  await appendCredentialAudit(env, { action: 'add', name: 'github.token', via: 'form', requestedBy: 'atlas', env: 'GH_TOKEN', bindingFor: 'atlas' });
  await appendCredentialAudit(env, { action: 'bind', name: 'npm.token', agentId: 'kai', via: 'cli', env: 'NPM_TOKEN', bindingFor: 'kai' });
  const lines = (await readFile(credentialAuditPath(env), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
  assert.deepEqual(lines.map(({ at: _at, ...rest }) => rest), [
    { action: 'add', name: 'github.token', store: 'shared', via: 'form', requestedBy: 'atlas', env: 'GH_TOKEN', bindingFor: 'atlas' },
    { action: 'bind', name: 'npm.token', store: 'agent:kai', via: 'cli', env: 'NPM_TOKEN', bindingFor: 'kai' },
  ]);
});
