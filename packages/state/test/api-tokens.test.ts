import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  API_TOKEN_PREFIX,
  apiTokensPath,
  createApiToken,
  hashApiToken,
  loadApiTokens,
  revokeApiToken,
} from '../src/index.ts';

const newEnv = async (): Promise<{ homeDir: string }> => ({
  homeDir: await mkdtemp(path.join(os.tmpdir(), 'stratus-api-tokens-')),
});

test('a created member token is stored as a hash in a 0600 file, never as itself', async () => {
  const env = await newEnv();
  const { token, record } = await createApiToken(env, { name: 'alice' });

  assert.ok(token.startsWith(API_TOKEN_PREFIX), 'recognisable as a member token');
  assert.equal(record.role, 'member');
  assert.match(record.id, /^tok_[0-9a-f]{12}$/);
  assert.equal(record.hash, hashApiToken(token));

  const raw = await readFile(apiTokensPath(env), 'utf8');
  assert.ok(!raw.includes(token), 'the token itself is never written');
  assert.ok(!raw.includes(token.slice(API_TOKEN_PREFIX.length)), 'nor its random part');
  assert.equal((await stat(apiTokensPath(env))).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(apiTokensPath(env)))).mode & 0o777, 0o700);

  assert.deepEqual(await loadApiTokens(env), [record]);
});

test('a second write keeps the file 0600 even when it had been loosened', async () => {
  const env = await newEnv();
  await createApiToken(env, { name: 'alice' });
  const { chmod } = await import('node:fs/promises');
  await chmod(apiTokensPath(env), 0o644);
  await createApiToken(env, { name: 'bob' });
  assert.equal((await stat(apiTokensPath(env))).mode & 0o777, 0o600);
});

test('a duplicate name is refused case-insensitively, naming the one that holds it', async () => {
  const env = await newEnv();
  const { record } = await createApiToken(env, { name: 'alice' });
  await assert.rejects(createApiToken(env, { name: 'Alice' }), new RegExp(`already exists \\(${record.id}\\)`));
  assert.equal((await loadApiTokens(env)).length, 1);
});

test('a name that is not one, or is spelled like an id, is refused with the rule', async () => {
  const env = await newEnv();
  for (const name of ['', 'has space', 'api:alice', '-leading', 'x'.repeat(65)]) {
    await assert.rejects(createApiToken(env, { name }), /is not a token name\. Use letters/, JSON.stringify(name));
  }
  await assert.rejects(createApiToken(env, { name: 'tok_0123456789ab' }), /spelled like a token id/);
  await assert.rejects(createApiToken(env, { name: 'root', role: 'operator' }), /gateway-token/);
});

test('revoke takes an id or a name and removes exactly that token', async () => {
  const env = await newEnv();
  const alice = await createApiToken(env, { name: 'alice' });
  const bob = await createApiToken(env, { name: 'bob' });
  const carol = await createApiToken(env, { name: 'carol' });

  assert.deepEqual(await revokeApiToken(env, alice.record.id), alice.record);
  assert.deepEqual(await revokeApiToken(env, 'BOB'), bob.record);
  assert.equal(await revokeApiToken(env, 'nobody'), undefined);
  assert.deepEqual(await loadApiTokens(env), [carol.record]);
});

test('an entry claiming any role but member is never loaded, so the file cannot mint a second operator', async () => {
  const env = await newEnv();
  const { record } = await createApiToken(env, { name: 'alice' });
  const raw = JSON.parse(await readFile(apiTokensPath(env), 'utf8')) as { tokens: Array<Record<string, unknown>> };
  raw.tokens.push({ ...record, id: 'tok_aaaaaaaaaaaa', name: 'root', role: 'operator' });
  await writeFile(apiTokensPath(env), JSON.stringify(raw));
  assert.deepEqual((await loadApiTokens(env)).map((entry) => entry.name), ['alice']);
});

test('a file of the wrong shape or a newer version is refused by name rather than read as empty', async () => {
  const env = await newEnv();
  await createApiToken(env, { name: 'alice' });
  await writeFile(apiTokensPath(env), '{"version":2,"tokens":[]}');
  await assert.rejects(loadApiTokens(env), /version 2.*stratus update/);
  // And a create refuses rather than writing over what it could not read.
  await assert.rejects(createApiToken(env, { name: 'bob' }), /version 2/);
  await writeFile(apiTokensPath(env), 'not json');
  await assert.rejects(loadApiTokens(env), /not valid JSON/);
});
