import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentWorkspacePath,
  globalConfigPath,
  readTrustedConfigBlock,
  validateConfigFile,
  workspacesDirPath,
} from '../src/index.ts';

const validate = (plugins: unknown) => validateConfigFile({ plugins }, 'config.json');

test('the plugins block is keyed by package name and shape-checked, not interpreted', () => {
  const config = validate({
    '@stratusagent/tool-fs': { enabled: true, roots: ['~/notes'], agents: { ava: { roots: ['~/work/ava'] } } },
    'stratus-plugin-github': { org: 'stratuslabs' },
  });

  assert.deepEqual(config.plugins?.['@stratusagent/tool-fs']?.roots, ['~/notes']);
  assert.deepEqual(config.plugins?.['@stratusagent/tool-fs']?.agents, { ava: { roots: ['~/work/ava'] } });
  // A plugin's own keys are the manifest's business: this loader passes an
  // unknown setting through rather than pretending to know what is valid.
  assert.equal(config.plugins?.['stratus-plugin-github']?.org, 'stratuslabs');
});

test('a misshapen plugins block is refused rather than dropped', () => {
  assert.throws(() => validate(['@stratusagent/tool-fs']), /expected an object keyed by package name/);
  assert.throws(() => validate({ '@stratusagent/tool-fs': true }), /expected an object of settings/);
  assert.throws(() => validate({ '@stratusagent/tool-fs': { enabled: 'yes' } }), /enabled in config.*Use true or false/);
  assert.throws(() => validate({ '@stratusagent/tool-fs': { agents: [] } }), /agents in config.*keyed by agent id/);
  assert.throws(
    () => validate({ '@stratusagent/tool-fs': { agents: { ava: 'everything' } } }),
    /agents\.ava in config.*expected an object of settings/,
  );
});

test('a project-local config cannot decide which code runs inside the daemon', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-trust-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-trust-project-'));
  await mkdir(path.dirname(globalConfigPath({ homeDir: home })), { recursive: true });

  await writeFile(
    path.join(project, 'stratus.config.json'),
    JSON.stringify({ plugins: { 'stratus-plugin-anything': { enabled: true } } }),
  );

  const untrusted = await readTrustedConfigBlock('plugins', { homeDir: home, cwd: project });
  assert.equal(untrusted.status, 'untrusted');

  // The same block in the global config the operator wrote is honoured.
  await writeFile(
    globalConfigPath({ homeDir: home }),
    JSON.stringify({ plugins: { '@stratusagent/tool-fs': { enabled: true } } }),
  );
  const trusted = await readTrustedConfigBlock('plugins', { homeDir: home, cwd: home });
  assert.equal(trusted.status, 'present');
  assert.deepEqual(trusted.status === 'present' ? Object.keys(trusted.value) : [], ['@stratusagent/tool-fs']);

  // An explicit --config is a choice the user made, so it is trusted
  // wherever it lives — including inside the project directory.
  const pinned = await readTrustedConfigBlock(
    'plugins',
    { homeDir: home, cwd: home },
    path.join(project, 'stratus.config.json'),
  );
  assert.equal(pinned.status, 'present');
});

test('reading a block that is absent, or a config that will not parse, says which', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-trust-empty-'));
  assert.equal((await readTrustedConfigBlock('plugins', { homeDir: home, cwd: home })).status, 'absent');

  await mkdir(path.dirname(globalConfigPath({ homeDir: home })), { recursive: true });
  await writeFile(globalConfigPath({ homeDir: home }), '{ not json');
  const broken = await readTrustedConfigBlock('plugins', { homeDir: home, cwd: home });
  assert.equal(broken.status, 'unreadable');
});

test('tool output has one directory per agent under the Stratus home', () => {
  const env = { homeDir: '/home/ada' };
  assert.equal(workspacesDirPath(env), '/home/ada/.stratus/workspaces');
  assert.equal(agentWorkspacePath(env, 'ava'), '/home/ada/.stratus/workspaces/ava');
});
