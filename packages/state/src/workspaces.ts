import { readdir } from 'node:fs/promises';
import type { AgentWorkspaces } from '@stratusagent/core';
import { isValidAgentId } from '@stratusagent/agents';
import { type StateEnvironment } from './environment.ts';
import { agentWorkspacePath, agentsDirPath } from './paths.ts';

/**
 * The host's answer to "where does this agent's output go", handed to
 * plugins through `PluginContext.workspaces`.
 *
 * This exists so the join lives in one place. Before it, five plugins each
 * appended the agent id to a `workspaceRoot` they were given, which made
 * every one of them a copy of the layout — and all five had to change when
 * the workspace moved out of `~/.stratus/workspaces/<id>` and into the
 * agent's own directory. A plugin now asks; only this file knows.
 */
export const createAgentWorkspaces = (env: StateEnvironment): AgentWorkspaces => ({
  forAgent: (agentId) => agentWorkspacePath(env, agentId),
  /**
   * Read from disk on every call rather than from the roster, and the
   * difference is the point: the caller is the provenance ledger's guard,
   * which has to recognise *any* agent's ledger — including one whose soul
   * has been removed, whose workspace is still on disk and whose ledger a
   * write must still refuse to overwrite. A roster read would answer with
   * the agents that can currently run, which is a different question.
   *
   * Directories only: `agents/` also holds the souls themselves, and,
   * until the upgrade move has run, the legacy `<id>.whitelist.json` files.
   * A `Dirent` reports a symlink as a link rather than a directory, which
   * is right here — a linked `agents/<id>` is not a state directory this
   * build will serve, and the guard canonicalizes what it is given anyway.
   *
   * And names that could be an agent's: `agentWorkspacePath` refuses an id
   * that is not a safe path segment, and this is a directory listing, not a
   * roster — a `.cache/` somebody dropped in here would otherwise throw out
   * of a call `fs.read` makes on every single read.
   */
  all: async () => {
    let entries;
    try {
      entries = await readdir(agentsDirPath(env), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && isValidAgentId(entry.name))
      .map((entry) => agentWorkspacePath(env, entry.name));
  },
});
