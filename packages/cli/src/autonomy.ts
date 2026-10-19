import path from 'node:path';
import type { JsonObject } from '@stratusagent/core';
import { resolvePluginAgentConfig } from '@stratusagent/plugins';
import { agentWorkspacePath, resolveAgentApprovals, type ApprovalsConfig, type StateEnvironment } from '@stratusagent/state';

/**
 * The directory an agent with `autonomy: workspace` may work in unattended,
 * or undefined when autonomy is off for it.
 *
 * The same directory the shell resolves for the agent, so the policy and
 * the command agree on where "inside" is: `tool-shell`'s own `workspaceRoot`
 * (per agent or shared) joined with the id when one is configured, the
 * host's workspace otherwise. See `workspaceResolver` in
 * `@stratusagent/plugins`, whose precedence this follows.
 */
export const autonomyDirectory = (
  approvals: ApprovalsConfig,
  plugins: Record<string, unknown>,
  env: StateEnvironment,
  agentId: string,
): string | undefined =>
  resolveAgentApprovals(approvals, agentId).autonomy === 'workspace'
    ? agentShellWorkspace(plugins, env, agentId)
    : undefined;

/**
 * The directory the shell resolves for the agent, whether or not autonomy
 * is on: where a command granted by name may point, and where a compound
 * command may write its output (see `compound.ts` in
 * `@stratusagent/permissions`).
 */
export const agentShellWorkspace = (
  plugins: Record<string, unknown>,
  env: StateEnvironment,
  agentId: string,
): string => {
  const shell = plugins['@stratusagent/tool-shell'];
  const root = shell !== null && typeof shell === 'object' && !Array.isArray(shell)
    ? resolvePluginAgentConfig(shell as JsonObject, agentId).workspaceRoot
    : undefined;
  return typeof root === 'string' && root.length > 0 ? path.join(root, agentId) : agentWorkspacePath(env, agentId);
};

/**
 * Shells whose syntax the compound reader in `@stratusagent/permissions`
 * models: POSIX `sh` and the shells that run it as written. zsh, tcsh, csh,
 * fish and ksh each read some line differently (`>!` is a redirection to
 * zsh and tcsh, `=ls` a path to zsh), so for them a line is never read as a
 * compound command and no grant applies by name.
 */
const POSIX_SHELLS = new Set(['sh', 'bash', 'dash']);

/**
 * The workspace a by-name grant or a compound command may use for this
 * agent (`agentShellWorkspace`), or undefined when its configured shell is
 * not one `POSIX_SHELLS` names, which keeps every command to the scopes
 * judged one at a time.
 */
export const agentShellGrantRoot = (
  plugins: Record<string, unknown>,
  env: StateEnvironment,
  agentId: string,
): string | undefined => {
  const shell = plugins['@stratusagent/tool-shell'];
  const configured = shell !== null && typeof shell === 'object' && !Array.isArray(shell)
    ? resolvePluginAgentConfig(shell as JsonObject, agentId).shell
    : undefined;
  const binary = typeof configured === 'string' && configured.length > 0 ? configured : '/bin/sh';
  return POSIX_SHELLS.has(path.basename(binary)) ? agentShellWorkspace(plugins, env, agentId) : undefined;
};
