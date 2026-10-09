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
): string | undefined => {
  if (resolveAgentApprovals(approvals, agentId).autonomy !== 'workspace') {
    return undefined;
  }
  const shell = plugins['@stratusagent/tool-shell'];
  const root = shell !== null && typeof shell === 'object' && !Array.isArray(shell)
    ? resolvePluginAgentConfig(shell as JsonObject, agentId).workspaceRoot
    : undefined;
  return typeof root === 'string' && root.length > 0 ? path.join(root, agentId) : agentWorkspacePath(env, agentId);
};
