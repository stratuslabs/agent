import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentWorkspaces } from '@stratusagent/core';

/**
 * How a plugin finds an agent's workspace, from whichever of the two the
 * host gave it.
 *
 * One implementation because there used to be five. Every plugin that
 * writes a file was handed a `workspaceRoot` and appended the agent id to
 * it, so each of them held a copy of the layout — and all five had to
 * change when the workspace moved into the agent's own state directory,
 * which is the cost that key was introduced to avoid and did not.
 *
 * An explicitly configured `workspaceRoot` wins, and the order matters:
 * the loader no longer fills that key with the host's answer — the seam
 * *is* the host's answer — so a value there is one an operator wrote, and
 * relocating a workspace by writing it down is a thing they are documented
 * to be able to do. Under it the old contract still holds: one directory
 * per agent directly under the configured root, which is also what a host
 * wiring a plugin by hand with no layout of its own supplies.
 *
 * Undefined means this host gave the plugin nowhere to write. A caller
 * that needs a path must fail the call naming what is missing rather than
 * choosing a directory of its own.
 */
export const workspaceResolver = (
  workspaces: AgentWorkspaces | undefined,
  workspaceRoot: string | undefined,
): ((agentId: string) => string) | undefined => {
  if (workspaceRoot !== undefined && workspaceRoot.length > 0) {
    const root = workspaceRoot;
    return (agentId) => path.join(root, agentId);
  }
  if (workspaces !== undefined) {
    return (agentId) => workspaces.forAgent(agentId);
  }
  return undefined;
};

/**
 * Every agent workspace on this host, for the guard that has to recognise
 * any agent's file rather than the caller's — see `ledgerGuard`.
 *
 * Same precedence as `workspaceResolver`: a configured root's own entries
 * are the agents, which is what reading `workspaceRoot` as a root means,
 * and the seam answers otherwise. A root that is not there yet holds no
 * agents rather than failing, because a guard runs before the first write
 * as well as after it — but only a root that is genuinely absent. See the
 * catch below for why every other failure has to reach the caller.
 */
export const allAgentWorkspaces = async (
  workspaces: AgentWorkspaces | undefined,
  workspaceRoot: string | undefined,
): Promise<readonly string[]> => {
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    return workspaces !== undefined ? workspaces.all() : [];
  }
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(workspaceRoot, entry.name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A root that is not there yet, or is not a directory, holds no
    // workspaces and so no ledgers — nothing for a guard to miss.
    //
    // Anything else propagates, and the caller fails its tool call. This
    // list is what `ledgerGuard` is built from, and an empty one is a guard
    // that answers "not a ledger" to every path — so swallowing `EACCES`
    // (a root that is executable but not listable, whose children are still
    // writable by name) or a transient `EMFILE` would let `fs.write`
    // truncate an agent's provenance ledger. "Cannot tell" is not "nothing
    // to protect".
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return [];
    }
    throw error;
  }
};
