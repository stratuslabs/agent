import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { autonomyDirectory } from '../src/autonomy.ts';

test('the autonomy directory is the one the shell resolves, and nothing when autonomy is off', () => {
  const env = { homeDir: '/home/op' };
  const on = { agents: { nova: { autonomy: 'workspace' as const } } };
  assert.equal(autonomyDirectory({}, {}, env, 'nova'), undefined);
  assert.equal(autonomyDirectory(on, {}, env, 'blair'), undefined);
  // The host's workspace by default.
  assert.equal(autonomyDirectory(on, {}, env, 'nova'), path.join('/home/op', '.stratus', 'agents', 'nova', 'workspace'));
  // tool-shell's own workspaceRoot when configured, shared or per agent.
  assert.equal(autonomyDirectory(on, { '@stratusagent/tool-shell': { workspaceRoot: '/srv/work' } }, env, 'nova'), path.join('/srv/work', 'nova'));
  assert.equal(
    autonomyDirectory(on, { '@stratusagent/tool-shell': { agents: { nova: { workspaceRoot: '/srv/nova' } } } }, env, 'nova'),
    path.join('/srv/nova', 'nova'),
  );
});
