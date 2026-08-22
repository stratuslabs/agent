import test from 'node:test';
import assert from 'node:assert/strict';

import {
  declaredRiskFor,
  parsePluginManifest,
  resolvePluginAgentConfig,
  validatePluginConfig,
  PluginConfigError,
  PluginManifestError,
} from '../src/index.ts';

const manifestOf = (stratus: unknown, name = 'stratus-plugin-example') =>
  parsePluginManifest({ name, stratus }, name);

test('a manifest is read without importing the package it describes', () => {
  const manifest = manifestOf({
    pluginVersion: 1,
    contributes: {
      tools: [{ name: 'github.pr.comment', risk: 'gated' }, { name: 'github.pr.read', risk: 'safe' }],
      skills: [{ id: 'pr-review', path: './skills/pr-review/SKILL.md' }],
    },
    credentials: ['GITHUB_TOKEN'],
    config: { type: 'object', properties: { org: { type: 'string' } } },
  });

  assert.equal(manifest.packageName, 'stratus-plugin-example');
  assert.deepEqual(manifest.contributes.tools.map((tool) => tool.name), ['github.pr.comment', 'github.pr.read']);
  assert.deepEqual(manifest.credentials, ['GITHUB_TOKEN']);
  assert.deepEqual(manifest.contributes.skills, [{ id: 'pr-review', path: './skills/pr-review/SKILL.md' }]);
});

test('a tool that forgot to think about risk is gated, never safe', () => {
  const manifest = manifestOf({ pluginVersion: 1, contributes: { tools: [{ name: 'fs.read' }] } });
  assert.equal(manifest.contributes.tools[0]?.risk, 'gated');
});

test('a manifest that cannot be trusted to describe its package is refused', () => {
  assert.throws(() => manifestOf(undefined), /not a Stratus plugin/);
  assert.throws(() => manifestOf({ pluginVersion: 2, contributes: {} }), /pluginVersion 2/);
  assert.throws(
    () => manifestOf({ pluginVersion: 1, contributes: { tools: [{ name: 'Shell Run' }] } }),
    /is not a tool name/,
  );
  assert.throws(
    () => manifestOf({ pluginVersion: 1, contributes: { tools: [{ name: 'fs.read', risk: 'harmless' }] } }),
    /Use safe, gated, or dangerous/,
  );
  assert.throws(
    () => manifestOf({ pluginVersion: 1, contributes: { toolsDiscovered: [{ namespace: 'mcp' }] } }),
    /is not a namespace/,
  );
  assert.throws(
    () => manifestOf({ pluginVersion: 1, contributes: { skills: [{ id: 'PR Review', path: './s.md' }] } }),
    /is not a skill id/,
  );
  // Refused here, before anything stages: a duplicate that only surfaced
  // at registration would land the plugin half — tools committed, first
  // skill live, plugin reported failed.
  assert.throws(
    () => manifestOf({
      pluginVersion: 1,
      contributes: { skills: [{ id: 'pr-review', path: './a.md' }, { id: 'pr-review', path: './b.md' }] },
    }),
    /declares "pr-review" twice/,
  );
  assert.throws(
    () => manifestOf({ pluginVersion: 1, contributes: { tools: 'fs.read' } }),
    PluginManifestError as never,
  );

  // Contributing nothing is not an error: a plugin may register only hooks,
  // which the manifest has no list for.
  assert.deepEqual(manifestOf({ pluginVersion: 1 }).contributes.tools, []);
});

test('a declared namespace authorises names inside it and nothing else', () => {
  const manifest = manifestOf({
    pluginVersion: 1,
    contributes: {
      tools: [{ name: 'mcp.ping', risk: 'safe' }],
      toolsDiscovered: [{ namespace: 'mcp.*', risk: 'gated' }],
    },
  });

  // Discovered under the namespace: registrable, at the namespace's risk.
  assert.equal(declaredRiskFor(manifest, 'mcp.linear.create_issue'), 'gated');
  // A literal declaration is more specific than the namespace it sits in.
  assert.equal(declaredRiskFor(manifest, 'mcp.ping'), 'safe');
  // Outside the namespace: not authorised at all, whatever the plugin says.
  assert.equal(declaredRiskFor(manifest, 'fs.write'), undefined);
  assert.equal(declaredRiskFor(manifest, 'mcpx.thing'), undefined);
});

test('a config block is validated against the manifest schema, per-agent entries included', () => {
  const manifest = manifestOf({
    pluginVersion: 1,
    contributes: { tools: [{ name: 'fs.read', risk: 'safe' }] },
    config: {
      type: 'object',
      properties: { roots: { type: 'array', items: { type: 'string' } }, maxBytes: { type: 'integer' } },
      required: ['roots'],
      additionalProperties: false,
    },
  });

  validatePluginConfig(manifest, { enabled: true, roots: ['~/notes'], agents: { ava: { roots: ['~/work/ava'] } } });

  assert.throws(() => validatePluginConfig(manifest, { enabled: true }), /missing required setting "roots"/);
  assert.throws(
    () => validatePluginConfig(manifest, { roots: 'everything' }),
    /must be a array/,
  );
  assert.throws(
    () => validatePluginConfig(manifest, { roots: ['~/notes'], maxBytes: 'lots' }),
    /must be a integer/,
  );
  assert.throws(
    () => validatePluginConfig(manifest, { roots: ['~/notes'], rooots: [] }),
    /no setting named "rooots"/,
  );
  // A per-agent entry says what differs for that agent, so holding it to the
  // schema's required list would make the defaults above it unusable.
  validatePluginConfig(manifest, { roots: ['~/notes'], agents: { ava: { maxBytes: 10 } } });
  assert.throws(
    () => validatePluginConfig(manifest, { roots: ['~/notes'], agents: { ava: { maxBytes: 'lots' } } }),
    PluginConfigError as never,
  );
});

test('an agent gets its own settings over the defaults, key by key', () => {
  const block = {
    enabled: true,
    roots: ['~/notes'],
    maxBytes: 4096,
    agents: { ava: { roots: ['~/work/ava'] }, juno: { roots: ['~/work/juno', '~/shared'] } },
  };

  // Its own roots, but the default it did not override.
  assert.deepEqual(resolvePluginAgentConfig(block, 'ava'), { roots: ['~/work/ava'], maxBytes: 4096 });
  assert.deepEqual(resolvePluginAgentConfig(block, 'juno'), { roots: ['~/work/juno', '~/shared'], maxBytes: 4096 });
  // An agent with no entry gets the defaults — never another agent's.
  assert.deepEqual(resolvePluginAgentConfig(block, 'rex'), { roots: ['~/notes'], maxBytes: 4096 });
  // The host's own keys never reach the plugin.
  assert.equal('enabled' in resolvePluginAgentConfig(block, 'ava'), false);
  assert.equal('agents' in resolvePluginAgentConfig(block, 'ava'), false);
  assert.deepEqual(resolvePluginAgentConfig(undefined, 'ava'), {});
});
