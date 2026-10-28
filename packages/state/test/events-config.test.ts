import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  addNamedCredential,
  ignoredConfigKeys,
  resolveDaemonCredential,
  validateConfigFile,
} from '../src/index.ts';

test('an events block loads with its listen address, body limit and sources', () => {
  const parsed = validateConfigFile({
    events: {
      listen: { host: ' 0.0.0.0 ', port: 4124 },
      maxBodyBytes: 65_536,
      sources: {
        github: { verify: 'github', secrets: ['events.github'] },
        'agent-board_2': { verify: 'standard-webhooks', secrets: ['events.agentboard', 'events.agentboard.next'] },
      },
    },
  }, 'test-config');
  assert.deepEqual(parsed.events, {
    listen: { host: '0.0.0.0', port: 4124 },
    maxBodyBytes: 65_536,
    sources: {
      github: { verify: 'github', secrets: ['events.github'] },
      'agent-board_2': { verify: 'standard-webhooks', secrets: ['events.agentboard', 'events.agentboard.next'] },
    },
  });
  assert.deepEqual(ignoredConfigKeys({ events: { sources: {} } }, 'test-config'), []);
});

test('an events block with no sources is kept empty, which means nothing listens', () => {
  assert.deepEqual(validateConfigFile({ events: {} }, 'test-config').events, {});
});

test('an events block that cannot be served as written is refused where it was written', () => {
  const refusals: Array<[unknown, RegExp]> = [
    ['on', /Invalid events in config/],
    [{ listen: { host: '' } }, /Invalid events\.listen\.host/],
    [{ listen: { port: 70_000 } }, /Invalid events\.listen\.port/],
    [{ listen: { port: 4124.5 } }, /Invalid events\.listen\.port/],
    [{ maxBodyBytes: 0 }, /Invalid events\.maxBodyBytes/],
    [{ maxBodyBytes: 64 * 1_048_576 }, /Invalid events\.maxBodyBytes/],
    [{ sources: [] }, /Invalid events\.sources/],
    [{ sources: { 'Has Space': { verify: 'github', secrets: ['events.github'] } } }, /Invalid events\.sources key "Has Space"/],
    [{ sources: { '../admin': { verify: 'github', secrets: ['events.github'] } } }, /Invalid events\.sources key/],
    [{ sources: { github: { verify: 'hmac', secrets: ['events.github'] } } }, /Invalid events\.sources\.github\.verify.*standard-webhooks.*github/],
    [{ sources: { github: { verify: 'github' } } }, /Invalid events\.sources\.github\.secrets/],
    [{ sources: { github: { verify: 'github', secrets: [] } } }, /Invalid events\.sources\.github\.secrets/],
    [{ sources: { github: { verify: 'github', secrets: ['has space'] } } }, /Invalid events\.sources\.github\.secrets/],
    [{ sources: { github: { verify: 'github', secrets: ['whsec_plaintextvalue', 'events.github'], extra: 1 } } }, /Invalid events\.sources\.github: unknown key "extra"/],
  ];
  for (const [events, message] of refusals) {
    assert.throws(() => validateConfigFile({ events }, 'test-config'), message, `accepted: ${JSON.stringify(events)}`);
  }
});

test('a source secret is a credential name, never a value in the config', () => {
  // A value pasted where a name goes would sit in config.json in plain text.
  assert.throws(
    () => validateConfigFile({ events: { sources: { board: { verify: 'standard-webhooks', secrets: ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'] } } } }, 'test-config'),
    /looks like a secret value/,
  );
});

test('a daemon credential resolves from the shared store, then the environment, and never from one agent\'s own keys', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-daemon-cred-'));
  const env = { homeDir: home, processEnv: {} };
  const withEnvValue = { homeDir: home, processEnv: { 'events.github': 'from-env' } };
  assert.equal(await resolveDaemonCredential(env, 'events.github'), undefined);
  await addNamedCredential(env, { name: 'events.github', value: 'agent-only', agentId: 'atlas' });
  assert.equal(await resolveDaemonCredential(env, 'events.github'), undefined, 'an agent-scoped key is that agent\'s');
  assert.equal(await resolveDaemonCredential(withEnvValue, 'events.github'), 'from-env');
  await addNamedCredential(env, { name: 'events.github', value: 'shared-value' });
  assert.equal(await resolveDaemonCredential(withEnvValue, 'events.github'), 'shared-value');
  assert.equal(await resolveDaemonCredential(env, 'toString'), undefined);
});
