import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { agentShellGrantRoot, autonomyDirectory } from '../src/autonomy.ts';

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

test('by-name grants and compound reading get a workspace only for a POSIX shell the reader models', () => {
  const env = { homeDir: '/home/op' };
  const home = path.join('/home/op', '.stratus', 'agents', 'nova', 'workspace');
  const shell = (value: unknown, perAgent = false) => ({
    '@stratusagent/tool-shell': perAgent ? { agents: { nova: { shell: value } } } : { shell: value },
  });
  assert.equal(agentShellGrantRoot({}, env, 'nova'), home);
  for (const name of ['/bin/sh', '/bin/bash', '/usr/bin/dash', 'bash']) {
    assert.equal(agentShellGrantRoot(shell(name), env, 'nova'), home, name);
  }
  // Codex P1 4309280000: tcsh (and zsh) read `>!` as a redirection, and
  // each has syntax of its own the reader was never written for.
  for (const name of ['/bin/tcsh', '/bin/csh', '/bin/zsh', '/usr/local/bin/fish', '/bin/ksh']) {
    assert.equal(agentShellGrantRoot(shell(name), env, 'nova'), undefined, name);
    assert.equal(agentShellGrantRoot(shell(name, true), env, 'nova'), undefined, `${name} per agent`);
  }
});
