import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry, type Tool } from '@stratusagent/core';

import { createDemoTool, toolsForRuntime, type RuntimeConfig } from '../src/index.ts';

// demo.echo exists for the offline demo provider, which calls it to show a
// tool round trip. A runner on any other provider gets the host's tools
// without it: not offered to the model, and not callable by name either.

const safeTool = (name: string): Tool => ({
  name,
  risk: 'safe',
  async execute() {
    return null;
  },
});

const hostTools = (): ToolRegistry => {
  const tools = new ToolRegistry();
  tools.register(createDemoTool());
  tools.register(safeTool('memory.recall'));
  return tools;
};

const anthropic = { provider: 'anthropic', apiKey: 'test-key', model: 'claude-opus-5-5' } as RuntimeConfig;

test('a demo runtime runs on the host tools, demo.echo included', () => {
  const tools = hostTools();
  const forDemo = toolsForRuntime(tools, { provider: 'demo' });
  assert.equal(forDemo, tools);
  assert.ok(forDemo.get('demo.echo'));
});

test('a real provider runtime neither lists nor finds demo.echo', () => {
  const tools = hostTools();
  const forReal = toolsForRuntime(tools, anthropic);
  assert.equal(forReal.get('demo.echo'), undefined);
  assert.deepEqual(forReal.list().map((tool) => tool.name), ['memory.recall']);
  assert.deepEqual(forReal.describe().map((tool) => tool.name), ['memory.recall']);
  // The host's own registry still has it: listings, plugin name checks
  // and allowlist warnings read that one, and nothing about them changes.
  assert.ok(tools.get('demo.echo'));
});

test('a real provider runtime sees tools the host registers or removes later', () => {
  const tools = hostTools();
  const forReal = toolsForRuntime(tools, anthropic);
  // A plugin reconnecting registers and drops tools on the host's registry
  // after the runner was built; the runner must see the registry as it is.
  tools.register(safeTool('fs.read'));
  assert.ok(forReal.get('fs.read'));
  tools.unregister('memory.recall');
  assert.deepEqual(forReal.list().map((tool) => tool.name), ['fs.read']);
});

test('a tool registered through the real provider view lands on the host registry', () => {
  // The runner registers skill.read itself when the host has not, into
  // whatever registry it was given; that has to be the host's, as before.
  const tools = hostTools();
  const forReal = toolsForRuntime(tools, anthropic);
  forReal.register(safeTool('skill.read'));
  assert.ok(tools.get('skill.read'));
  assert.ok(forReal.unregister('skill.read'));
  assert.equal(tools.get('skill.read'), undefined);
});
