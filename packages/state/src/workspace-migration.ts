import type { Dirent } from 'node:fs';
import { chmod, lstat, readdir, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { isValidAgentId } from '@stratusagent/agents';

import { type StateEnvironment } from './environment.ts';
import {
  agentDirectoryOrQuarantine,
  createStateDirectoryNames,
  type DirectoryReport,
} from './layout-migration.ts';
import {
  agentWorkspacePath,
  legacyWorkspacesDirPath,
  stratusHomePath,
} from './paths.ts';

// Step 15's fourth per-agent resource: the workspace, from
// `workspaces/<id>` to `agents/<id>/workspace`.
//
// The other three moved because their old homes were fleet-wide files two
// agents shared. This one already had a directory per agent, so the move
// buys something different: the workspace becomes a *descendant* of the
// agent's state directory instead of a sibling tree of it, which is what
// makes `agents/<id>/` the one path a backup, a `chmod`, or an "erase this
// agent" has to name. Everything one agent owns is under it, and nothing
// else is.
//
// The extra `workspace/` segment is the half of that which is load-bearing
// rather than tidy: `tool-fs` takes this directory as its default root, so
// the agent can read and write everything under it. With the workspace
// *as* `agents/<id>/` the agent's own `whitelist.json` — the file saying
// what it may do unattended — would be inside its own filesystem root.
// One segment down, the grants, the sessions and the memories are siblings
// of the root rather than descendants, and no canonicalized path inside it
// reaches them.
//
// A rename, and therefore its own marker: the workspace is in one place or
// the other, never both, so a second run finds nothing left to move. What
// this migration will not do is *merge*. Two workspaces for one agent mean
// two provenance ledgers, and folding them would mean picking a winner —
// the losing ledger's records are the labels on real files, so dropping
// them turns fetched text back into the agent's own words. Both are kept
// where they are and the agent is named instead.

/** What one run changed, for the line it reports. */
interface WorkspaceMigrationReport extends DirectoryReport {
  moved: number;
}

/**
 * Whether this entry of the legacy directory is an agent's workspace.
 *
 * Directories, and links to them. A link is what an operator who moved one
 * agent's output onto another volume left behind (`workspaces/ava ->
 * /data/ava`), and it is renamed as a link — so the output stays where
 * they put it and the new path reaches it the same way. A `Dirent` reports
 * a link as a link rather than a directory, which is why both are asked.
 *
 * A plain file directly in `workspaces/` is nobody's workspace and is left
 * alone. That is also why this migration does not remove the legacy
 * directory unless it empties: something an operator put there is theirs.
 */
const isWorkspaceEntry = (entry: Dirent): boolean => entry.isDirectory() || entry.isSymbolicLink();

/**
 * Move each `workspaces/<id>` into `agents/<id>/workspace`.
 *
 * Idempotent and restartable at every agent: one rename each, nothing read,
 * nothing merged, and an agent that cannot be moved is named and skipped
 * rather than aborting the fleet.
 */
export const applyPerAgentWorkspaces = async (env: StateEnvironment): Promise<string | undefined> => {
  const legacy = legacyWorkspacesDirPath(env);
  let entries: Dirent[];
  try {
    entries = await readdir(legacy, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Not there, or not a directory: either way it holds no workspaces.
    // `ENOTDIR` is a regular file somebody left at that name — aborting
    // over it would refuse every `stratus serve` for good, since the
    // migration that would clear it is the one failing.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
  const report: WorkspaceMigrationReport = {
    moved: 0,
    quarantined: [],
    directoryNames: createStateDirectoryNames(env),
  };
  for (const entry of entries) {
    if (!isWorkspaceEntry(entry)) {
      continue;
    }
    const agentId = entry.name;
    const from = path.join(legacy, agentId);
    if (!isValidAgentId(agentId)) {
      // It got here as a directory name, so the filesystem took it; what it
      // cannot be is a segment this build will join onto a path. Left where
      // it is, which loses nothing: the old directory is not deleted, and
      // an operator who renames the agent gets the move on the next
      // `stratus update`.
      report.quarantined.push(
        `${JSON.stringify(agentId)} — not a single path segment, so it has no directory to own; `
        + `left at ${path.relative(stratusHomePath(env), from)}`,
      );
      continue;
    }
    // The agent's directory before anything under it, and through the rule
    // 0003 uses: a name that is another spelling of this id on a folding
    // filesystem would otherwise put two agents' output in one workspace.
    if (await agentDirectoryOrQuarantine(env, agentId, 'workspace', report) === undefined) {
      report.quarantined.push(`${agentId} — left at ${path.relative(stratusHomePath(env), from)}`);
      continue;
    }
    const target = agentWorkspacePath(env, agentId);
    // `rename` onto an existing empty directory succeeds on some platforms
    // and fails with ENOTEMPTY on the same call a moment later, so the
    // destination is asked about rather than tried. Both are kept — see the
    // note at the top on why two workspaces are never merged.
    //
    // `lstat`, not `readdir` or `stat`: a *dangling* symlink at the
    // destination is something there, and both of those report it as
    // ENOENT. Renaming a directory over it would fail — after this
    // migration had decided the name was free — and a link an operator
    // pointed somewhere is theirs to fix either way.
    let occupied = true;
    try {
      await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        occupied = false;
      }
      // Anything else is a destination this migration will not write into.
    }
    if (occupied) {
      report.quarantined.push(
        `${agentId} — ${path.relative(stratusHomePath(env), target)} already exists, and two workspaces hold `
        + 'two provenance ledgers that cannot be folded into one; '
        + `the older one is left at ${path.relative(stratusHomePath(env), from)}`,
      );
      continue;
    }
    try {
      await rename(from, target);
    } catch (error) {
      // Loud, and not quarantined, which is the opposite of how an id with
      // nowhere to land is treated — because the consequence is opposite
      // too. This workspace holds the agent's provenance ledger: leaving it
      // behind and letting the agent start a fresh one would make every
      // file it fetched read back as its own words, silently. A daemon that
      // will not start says so and can be fixed by hand; a label that went
      // missing cannot be noticed.
      //
      // `EXDEV` is the one that actually happens: a workspace an operator
      // mounted rather than linked cannot be renamed across the mount.
      throw new Error(
        `Could not move ${JSON.stringify(agentId)}'s workspace from ${from} to ${target} `
        + `(${(error as NodeJS.ErrnoException).code ?? 'unknown error'}). It holds that agent's provenance `
        + 'ledger, so it is not safe to leave behind: move the directory by hand, or replace a mount at '
        + 'that path with a symlink, and run `stratus update` again.',
      );
    }
    if (!entry.isSymbolicLink()) {
      // `agents/<id>/` is already owner-only, so this changes nothing an
      // attacker could reach today — it is for the workspace that gets
      // moved out again, or read through a path that is not this one. Never
      // on a link: `chmod` follows it, and the mode of whatever an operator
      // pointed it at is not this migration's to change.
      await chmod(target, 0o700);
    }
    report.moved += 1;
  }
  // Only when it empties, and never recursively: an operator's own file in
  // here is theirs, and a quarantined workspace is the one copy of that
  // agent's output.
  try {
    await rmdir(legacy);
  } catch {
    // Still holding something. Nothing to report: what is left is either
    // named above or was never this migration's.
  }
  if (report.moved === 0 && report.quarantined.length === 0) {
    return undefined;
  }
  const summary = report.moved > 0 ? `moved ${report.moved} workspace(s)` : 'moved nothing';
  return report.quarantined.length > 0
    ? `${summary}; QUARANTINED, left in ${path.basename(legacy)}/: ${report.quarantined.join('; ')}`
    : summary;
};
