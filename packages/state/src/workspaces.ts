import { chmodSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { AgentWorkspaces } from '@stratusagent/core';
import { isValidAgentId } from '@stratusagent/agents';
import { isSymlinkedStatePathSync, symlinkedStateDirectoryMessage } from '@stratusagent/permissions';
import { type StateEnvironment } from './environment.ts';
import { agentStateDirPath, agentWorkspacePath, agentsDirPath } from './paths.ts';

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
export const createAgentWorkspaces = (env: StateEnvironment): AgentWorkspaces => {
  // Per instance, and only to keep the syscalls off the hot path: the
  // ledger resolves a workspace on every `fs.write` check. Correctness does
  // not rest on it — a directory somebody loosened under a running daemon
  // is retightened by the next process, and nothing here caches the path.
  const secured = new Set<string>();
  return {
    /**
     * Created, and created *secured*, rather than resolved and left to the
     * caller — and only for a caller that says it is about to write, since
     * this is the half that can fail. The callers are file-producing
     * plugins, and every one of them
     * reaches for a recursive `mkdir` with no mode — which under the usual
     * `0022` umask left `agents/<id>/` itself at `0755` when `tool-shell`
     * was the first to write. That directory is not an output directory:
     * the agent's sessions, memories and `whitelist.json` are siblings of
     * the workspace inside it, and the rest of the state code creates it at
     * `0700` precisely so they are not world-readable. A plugin cannot be
     * expected to know that, so the host that owns the layout does it.
     */
    forAgent: (agentId) => agentWorkspacePath(env, agentId),
    prepare: (agentId) => {
      const workspace = agentWorkspacePath(env, agentId);
      if (secured.has(workspace)) {
        return workspace;
      }
      const stateDir = agentStateDirPath(env, agentId);
      // `chmod` follows links, so a planted `agents/<id>` would hand its
      // target's mode to whatever it points at — and the state written
      // through it would land there too. Same rule, same message, as every
      // other writer of an agent's state directory.
      if (isSymlinkedStatePathSync(stateDir)) {
        throw new Error(symlinkedStateDirectoryMessage(stateDir));
      }
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      // `mkdir`'s mode applies only to what it creates, so a directory an
      // older build or a pre-fix plugin already left is whatever it was —
      // and that is the common case here, since the builds that created
      // these under the umask are exactly the ones being upgraded from.
      chmodSync(stateDir, 0o700);
      // The workspace itself only when it is a real directory. It is the
      // one thing under `agents/<id>/` that may be a symlink — an operator
      // relocating an agent's output to another volume is supported — and
      // `chmod` follows links, so the mode of a directory they chose is
      // not this build's to change.
      if (!isSymlinkedStatePathSync(workspace)) {
        chmodSync(workspace, 0o700);
      }
      secured.add(workspace);
      return workspace;
    },
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
  };
};
