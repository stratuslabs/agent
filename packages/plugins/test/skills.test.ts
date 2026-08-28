import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EventBus,
  SkillRegistry,
  ToolRegistry,
  type Plugin,
  type Tool,
} from '@stratusagent/core';

import { loadPlugins, type OptionalModuleHost } from '../src/index.ts';

const tool = (name: string, risk?: Tool['risk']): Tool => ({
  name,
  ...(risk ? { risk } : {}),
  async execute() {
    return { ran: name };
  },
});

const SKILL_SOURCE = (label: string): string => `---
name: ${label}
description: Use when the task calls for ${label}.
---

# ${label}

The full ${label} procedure.
`;

/**
 * A host whose packages exist on disk — package.json plus whatever files
 * each package ships — so the loader's skill reads hit real files, which
 * is how they work in production.
 */
const fakeHost = async (
  packages: Record<string, { manifest: unknown; module?: unknown; files?: Record<string, string> }>,
): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugin-skills-'));
  const entries = new Map<string, string>();
  for (const [name, entry] of Object.entries(packages)) {
    const directory = path.join(root, name.replace(/[@/]/g, '_'));
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, ...(entry.manifest as object) }));
    for (const [relative, content] of Object.entries(entry.files ?? {})) {
      const filePath = path.join(directory, relative);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
    entries.set(name, pathToFileURL(path.join(directory, 'dist', 'index.js')).href);
  }
  return {
    resolve(specifier) {
      const resolved = entries.get(specifier);
      if (!resolved) {
        const error = new Error(`Cannot find package '${specifier}'`) as NodeJS.ErrnoException;
        error.code = 'ERR_MODULE_NOT_FOUND';
        throw error;
      }
      return resolved;
    },
    async import(specifier) {
      return packages[specifier]?.module ?? {};
    },
  };
};

const passivePlugin = (name: string, register?: (tools: ToolRegistry) => void) => ({
  createPlugin: (): Plugin => ({
    name,
    setup(context) {
      register?.(context.tools as ToolRegistry);
    },
  }),
});

test('a plugin contributing a skill and one contributing a same-named toolset install together, skill reachable qualified', async () => {
  const host = await fakeHost({
    'stratus-plugin-github': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'github.pr.read', risk: 'gated' }] } } },
      module: passivePlugin('github-tools', (tools) => tools.register(tool('github.pr.read'))),
    },
    'stratus-plugin-github-skills': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: { skills: [{ id: 'github', path: './skills/github/SKILL.md' }] },
        },
      },
      module: passivePlugin('github-skills'),
      files: { 'skills/github/SKILL.md': SKILL_SOURCE('github') },
    },
  });

  const skills = new SkillRegistry();
  const tools = new ToolRegistry();
  const result = await loadPlugins({
    config: {
      'stratus-plugin-github': { enabled: true },
      'stratus-plugin-github-skills': { enabled: true },
    },
    host,
    tools,
    skills,
    bus: new EventBus(),
  });

  assert.deepEqual(result.failures, []);
  assert.ok(tools.get('github.pr.read'));
  // The qualified form is the canonical id — the package name verbatim.
  const qualified = skills.resolve('stratus-plugin-github-skills:github');
  assert.equal(qualified?.name, 'github');
  assert.match(await skills.read('stratus-plugin-github-skills:github'), /full github procedure/);
  // The bare id works while nobody else claims it.
  assert.equal(skills.resolve('github')?.id, 'stratus-plugin-github-skills:github');

  const record = result.loaded.find((plugin) => plugin.package === 'stratus-plugin-github-skills')?.skills[0];
  assert.equal(record?.id, 'stratus-plugin-github-skills:github');
  assert.equal(record?.description, 'Use when the task calls for github.');
  // The alias is the registry's to answer, live — records carry none.
  assert.deepEqual(skills.idsFor('stratus-plugin-github-skills:github'), ['stratus-plugin-github-skills:github', 'github']);
});

test('two plugins contributing the same skill id resolve to their qualified forms; the bare id goes to neither', async () => {
  const host = await fakeHost({
    'stratus-plugin-acme': {
      manifest: { stratus: { pluginVersion: 1, contributes: { skills: [{ id: 'pr-review', path: './skills/SKILL.md' }] } } },
      module: passivePlugin('acme'),
      files: { 'skills/SKILL.md': SKILL_SOURCE('acme review') },
    },
    'stratus-plugin-zephyr': {
      manifest: { stratus: { pluginVersion: 1, contributes: { skills: [{ id: 'pr-review', path: './skills/SKILL.md' }] } } },
      module: passivePlugin('zephyr'),
      files: { 'skills/SKILL.md': SKILL_SOURCE('zephyr review') },
    },
  });

  const skills = new SkillRegistry();
  const result = await loadPlugins({
    config: {
      'stratus-plugin-acme': { enabled: true },
      'stratus-plugin-zephyr': { enabled: true },
    },
    host,
    tools: new ToolRegistry(),
    skills,
    bus: new EventBus(),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(skills.resolve('stratus-plugin-acme:pr-review')?.description, 'Use when the task calls for acme review.');
  assert.equal(skills.resolve('stratus-plugin-zephyr:pr-review')?.description, 'Use when the task calls for zephyr review.');
  assert.equal(skills.resolve('pr-review'), undefined);
});

test('a skill file that is missing or invalid refuses the plugin whole — its tools do not land either', async () => {
  const host = await fakeHost({
    'stratus-plugin-broken': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: {
            tools: [{ name: 'broken.run', risk: 'gated' }],
            skills: [{ id: 'vague', path: './skills/SKILL.md' }],
          },
        },
      },
      module: passivePlugin('broken', (tools) => tools.register(tool('broken.run'))),
      // Present but with no description — the identity routing runs on.
      files: { 'skills/SKILL.md': '---\nname: Vague\n---\n\nA procedure.' },
    },
    'stratus-plugin-absent': {
      manifest: { stratus: { pluginVersion: 1, contributes: { skills: [{ id: 'ghost', path: './skills/SKILL.md' }] } } },
      module: passivePlugin('absent'),
    },
  });

  const skills = new SkillRegistry();
  const tools = new ToolRegistry();
  const result = await loadPlugins({
    config: {
      'stratus-plugin-broken': { enabled: true },
      'stratus-plugin-absent': { enabled: true },
    },
    host,
    tools,
    skills,
    bus: new EventBus(),
  });

  assert.equal(result.loaded.length, 0);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures.find((f) => f.package === 'stratus-plugin-broken')?.reason ?? '', /not a valid SKILL\.md/);
  assert.match(result.failures.find((f) => f.package === 'stratus-plugin-absent')?.reason ?? '', /could not be read/);
  assert.equal(tools.get('broken.run'), undefined, 'a refused plugin left its tools registered');
  assert.equal(skills.list().length, 0);
});

test('a skill path reaching outside its package is refused', async () => {
  const host = await fakeHost({
    'stratus-plugin-escape': {
      manifest: { stratus: { pluginVersion: 1, contributes: { skills: [{ id: 'escape', path: '../../../etc/passwd' }] } } },
      module: passivePlugin('escape'),
    },
  });

  const result = await loadPlugins({
    config: { 'stratus-plugin-escape': { enabled: true } },
    host,
    tools: new ToolRegistry(),
    skills: new SkillRegistry(),
    bus: new EventBus(),
  });

  assert.equal(result.loaded.length, 0);
  assert.match(result.failures[0]?.reason ?? '', /outside its package/);
});

test('a manifest declaring one skill id twice refuses the plugin whole — nothing half-lands', async () => {
  const host = await fakeHost({
    'stratus-plugin-doubled': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: {
            tools: [{ name: 'doubled.run', risk: 'gated' }],
            skills: [
              { id: 'pr-review', path: './skills/SKILL.md' },
              { id: 'pr-review', path: './skills/SKILL.md' },
            ],
          },
        },
      },
      module: passivePlugin('doubled', (tools) => tools.register(tool('doubled.run'))),
      files: { 'skills/SKILL.md': SKILL_SOURCE('doubled review') },
    },
  });

  const skills = new SkillRegistry();
  const tools = new ToolRegistry();
  const result = await loadPlugins({
    config: { 'stratus-plugin-doubled': { enabled: true } },
    host,
    tools,
    skills,
    bus: new EventBus(),
  });

  assert.equal(result.loaded.length, 0);
  assert.match(result.failures[0]?.reason ?? '', /declares "pr-review" twice/);
  // The whole point: a refused plugin leaves nothing behind — neither its
  // tools nor the first of its duplicate skills.
  assert.equal(tools.get('doubled.run'), undefined);
  assert.deepEqual(skills.list(), []);
});

test('an operator skill already holding the bare id leaves the plugin skill reachable qualified only', async () => {
  const host = await fakeHost({
    'stratus-plugin-acme': {
      manifest: { stratus: { pluginVersion: 1, contributes: { skills: [{ id: 'code-review', path: './skills/SKILL.md' }] } } },
      module: passivePlugin('acme'),
      files: { 'skills/SKILL.md': SKILL_SOURCE('acme code review') },
    },
  });

  const skills = new SkillRegistry();
  // The operator's skill loaded first, as the gateway does.
  skills.register({
    id: 'code-review',
    name: 'code-review',
    description: 'The operator copy.',
    load: async () => 'operator body',
  });

  const result = await loadPlugins({
    config: { 'stratus-plugin-acme': { enabled: true } },
    host,
    tools: new ToolRegistry(),
    skills,
    bus: new EventBus(),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(skills.resolve('code-review')?.description, 'The operator copy.');
  assert.equal(skills.resolve('stratus-plugin-acme:code-review')?.description, 'Use when the task calls for acme code review.');
  // No bare alias landed: the qualified id is the plugin skill's only id.
  assert.deepEqual(skills.idsFor('stratus-plugin-acme:code-review'), ['stratus-plugin-acme:code-review']);
});
