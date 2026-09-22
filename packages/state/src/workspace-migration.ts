import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  appendFile,
  chmod,
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { isValidAgentId } from '@stratusagent/agents';
import { LEDGER_FILENAME } from '@stratusagent/plugins';

import { type StateEnvironment } from './environment.ts';
import {
  agentDirectoryOrQuarantine,
  createStateDirectoryNames,
  type DirectoryReport,
} from './layout-migration.ts';
import { memoryAppendNeedsNewline } from './memory.ts';
import {
  agentWorkspacePath,
  agentsDirPath,
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
// rather than tidy. The workspace is a directory an operator can hand to
// `fs` as a root — `tool-fs` carries a comment about exactly that case —
// and is what a sandboxed executor mounts. Before this move, naming it
// reached that agent's output and nothing else, because it lived outside
// `agents/`. With the workspace *as* `agents/<id>/`, the same operator
// choice would hand the agent its own `whitelist.json`, the file saying
// what it may do unattended. One segment down, the grants, the sessions and
// the memories are siblings of that root rather than descendants, and no
// canonicalized path inside it reaches them.
//
// What this migration is careful about is the **provenance ledger**, which
// lives at the top of the workspace and records which files came from
// outside. A label that goes missing is not a visible failure — the file
// reads back as the agent's own words — so two things that look like
// bookkeeping are the point of this file:
//
// - **A rename changes the absolute path of everything it moves, and the
//   ledger records absolute paths.** Every binary an MCP server returns is
//   written at `<workspace>/mcp/<server>/…` and recorded there, with no
//   operator configuration involved, so moving the workspace without
//   rewriting the ledger would strip the label off every one of them. The
//   records naming the old workspace are remapped onto the new one, *after*
//   the rename — a ledger rewritten for a move that then failed is a set of
//   labels pointing at nothing, and nothing can tell those records from
//   ones that legitimately named the destination. What makes a rewrite on
//   the far side of an irreversible rename finishable is the marker the
//   move leaves behind; see `MOVE_MARKER_FILENAME`.
// - **A destination that already exists is merged, not refused.** That is
//   the ordinary shape of an upgrade rather than an exotic one: an ordinary
//   command on the new build defers this migration — it needs the exclusive
//   bracket — while its plugins already resolve the *new* path, so the
//   first tool call that writes a file creates `agents/<id>/workspace` and
//   starts a ledger there. Refusing that would refuse `stratus serve` to
//   anyone who ran a command before restarting the daemon. The two ledgers
//   fold together instead, which the format allows by construction:
//   `parseLedger` keeps the lowest label recorded for a path whichever
//   process wrote it first, exactly so concurrent appenders can interleave.
//   Those records are *not* remapped — in this branch the files did not
//   move — and what is left of the old workspace stays where it is.

/** What one run changed, for the line it reports. */
interface WorkspaceMigrationReport extends DirectoryReport {
  moved: number;
  /** Agents whose old ledger was folded into one already at the new path. */
  merged: string[];
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

/** The ledger file at the top of a workspace. */
const ledgerIn = (workspace: string): string => path.join(workspace, LEDGER_FILENAME);

/**
 * The note a workspace carries while it is being moved: the paths its ledger
 * records were written against.
 *
 * It exists so the ledger can be rewritten *after* the rename rather than
 * before it, without that rewrite becoming unfinishable. Before was the
 * obvious answer — a failure there is retryable while a failure afterwards
 * is not, since the next run finds no legacy entry — but it is wrong for a
 * subtler reason: it leaves the ledger naming a move that may never happen,
 * and no later pass can tell those records from ones that legitimately name
 * the destination. A pre-layout build records every `fs.write` under the
 * agent's *configured roots*, and a root can cover `agents/<id>/workspace`
 * once something creates it.
 *
 * The marker settles it without guessing. It is written before the move,
 * travels with the directory, and is cleared once the rewrite is done — so a
 * run that dies anywhere in between leaves a workspace that says, in place,
 * exactly what remains to be done to it. {@link finishInterruptedMoves} is
 * what reads them, and it runs before anything else, because by then there
 * may be no legacy entry left to notice.
 */
const MOVE_MARKER_FILENAME = `${LEDGER_FILENAME}.moving`;

const markerIn = (workspace: string): string => path.join(workspace, MOVE_MARKER_FILENAME);

const writeMoveMarker = async (workspace: string, from: readonly string[]): Promise<void> => {
  await writeFile(markerIn(workspace), `${JSON.stringify({ from })}\n`, { mode: 0o600 });
  await chmod(markerIn(workspace), 0o600);
};

const readMoveMarker = async (workspace: string): Promise<string[] | undefined> => {
  let raw: string;
  try {
    raw = await readFile(markerIn(workspace), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { from?: unknown };
    const from = Array.isArray(parsed.from) ? parsed.from.filter((one): one is string => typeof one === 'string') : [];
    // A marker naming nothing is one this build cannot act on. Answering
    // with no spellings would silently skip the rewrite it exists to
    // finish, so it is the same as a marker that will not parse.
    return from.length > 0 ? from : undefined;
  } catch {
    return undefined;
  }
};

const clearMoveMarker = async (workspace: string): Promise<void> => {
  try {
    await unlink(markerIn(workspace));
  } catch {
    // Not there, which is the ordinary case: only a move writes one.
  }
};

/**
 * Every spelling of a path that a ledger record could be written as: the one
 * given, and its canonical form.
 *
 * The ledger is keyed the way `fs.read` looks a path up, through `realpath`,
 * and `~/.stratus` may itself be a symlink — so a record names the canonical
 * path while this migration walks the configured one. `base` answers for a
 * path that does not exist yet: its parent does, and the canonical name is
 * the parent's plus this one's last segment.
 */
const spellingsOf = async (target: string, base: 'self' | 'parent'): Promise<string[]> => {
  const spellings = [target];
  try {
    const canonical = base === 'self'
      ? await realpath(target)
      : path.join(await realpath(path.dirname(target)), path.basename(target));
    if (canonical !== target) {
      spellings.push(canonical);
    }
  } catch {
    // Not there to canonicalize: the spelling given is the only one.
  }
  return spellings;
};

/** Whether nothing at all is at this path — a dangling link is something. */
const pathIsFree = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
};

/**
 * `absolutePath` with one of `from` swapped for `to`, when it is one of them
 * or under it; undefined when it is under none.
 *
 * Containment is asked segment-wise, never by a `..` prefix on the relative
 * path. `..cache/notes.md` is a legitimate child — a leading `..` is legal
 * in a filename, and a *tainted session picks the filenames it writes*, so
 * a prefix test is a provenance bypass an attacker can arrange by name: the
 * file moves with the workspace, the record is judged "outside" and left
 * naming the old path, and the fetched content reads back as the agent's
 * own words.
 */
const reparented = (absolutePath: string, from: readonly string[], to: string): string | undefined => {
  for (const candidate of from) {
    const relative = path.relative(candidate, absolutePath);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      continue;
    }
    return relative.length === 0 ? to : path.join(to, relative);
  }
  return undefined;
};

/**
 * Rewrite the ledger's own records after the workspace under them moved.
 *
 * A ledger record is an absolute path, so a rename silently invalidates
 * every record naming a file inside the workspace — and `plugin-mcp` puts
 * every binary a server returns at `<workspace>/mcp/<server>/…` and records
 * it there, so this is the common case rather than a corner of it. A record
 * whose path is outside the workspace — the agent's ordinary `fs` roots,
 * which is most of them — is left exactly as it was.
 *
 * Lines that will not parse are copied through byte for byte. The reader
 * refuses such a ledger and says to delete it; rewriting one here would
 * change which error an operator sees, and this migration has no opinion
 * about a ledger that was already broken.
 *
 * Staged and renamed into place rather than written over, because a
 * truncated ledger is a set of labels gone.
 *
 * `from` is every spelling of the workspace worth matching, because the
 * ledger is keyed the way `fs.read` looks a path up — through `realpath` —
 * and `~/.stratus` may itself be a symlink. A record then names the
 * canonical path while this migration walks the configured one, and a
 * single-spelling comparison would quietly match nothing.
 */
const remapLedger = async (workspace: string, from: readonly string[], to: string): Promise<number> => {
  const ledgerPath = ledgerIn(workspace);
  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
  let remapped = 0;
  const lines = raw.split('\n').map((line) => {
    if (line.trim().length === 0) {
      return line;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return line;
    }
    const record = parsed as { path?: unknown };
    if (typeof record.path !== 'string') {
      return line;
    }
    const moved = reparented(record.path, from, to);
    if (moved === undefined) {
      return line;
    }
    remapped += 1;
    // Spread first, so every other field a record carries — the label, the
    // timestamp, anything a newer build writes — survives the rewrite.
    return JSON.stringify({ ...record, path: moved });
  });
  if (remapped === 0) {
    return 0;
  }
  const staging = `${ledgerPath}.rewriting-${randomUUID()}`;
  await writeFile(staging, lines.join('\n'), { mode: 0o600 });
  await chmod(staging, 0o600);
  await rename(staging, ledgerPath);
  return remapped;
};

/**
 * Fold the legacy workspace's ledger into the one already at the new path.
 *
 * Append-only and order-independent by construction — see the note at the
 * top — so this is a concatenation and nothing more. No remapping: the
 * files these records name have not moved, because this is the branch
 * where the legacy workspace stays where it is.
 *
 * The source is retired afterwards so a second run does not append the same
 * records again. Idempotent either way, since the labels would resolve the
 * same, but a file that grows on every `stratus serve` is its own defect.
 */
const foldLedgerInto = async (
  from: string,
  target: string,
): Promise<'none' | 'folded' | 'aliased' | 'unreachable'> => {
  const source = ledgerIn(from);
  // The destination's ledger can be this very file under another name, with
  // two real workspace directories on either side of it — see `sameEntry`.
  // Nothing to fold: the records are already live where a read will look.
  if (await sameEntry(source, ledgerIn(target))) {
    return 'aliased';
  }
  let raw: string;
  try {
    raw = await readFile(source, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'none';
    }
    throw error;
  }
  if (raw.trim().length > 0) {
    const destination = ledgerIn(target);
    try {
      // The rule the memory store already owns: an append onto a file whose
      // last byte is not a newline fuses two records into one unparseable
      // line — which, for a ledger, is a refusal to read any of it.
      const lead = await memoryAppendNeedsNewline(destination) ? '\n' : '';
      const body = raw.endsWith('\n') ? raw : `${raw}\n`;
      await appendFile(destination, `${lead}${body}`, { mode: 0o600 });
      await chmod(destination, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Something is at the destination — `pathIsFree` said so — but it is
      // not a directory these records can be written into: a dangling link
      // is the shape that reaches here. The source keeps its ledger, which
      // is the only copy of those labels, and the agent is named.
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return 'unreachable';
      }
      throw error;
    }
  }
  // Never over an archive already there: a run killed between the append
  // and this rename leaves one, and the retry must not bury it.
  const archive = `${source}.migrated`;
  await rename(source, await pathIsFree(archive) ? archive : `${archive}-${randomUUID()}`);
  return 'folded';
};

/**
 * Whether two paths are the same thing on disk, following links.
 *
 * Asked twice before folding one workspace's ledger into another's, because
 * the destination can be an alias of the source at either level, and
 * folding an alias is the same disaster both times: the append doubles a
 * ledger into itself, and retiring the source then leaves the destination
 * naming a file that is not there. The workspace is reachable at the new
 * path with no ledger at all, so `fs.write` stops refusing it, `fs.read`
 * labels nothing, and every record sits in a file nothing consults.
 *
 * The *directory* can be an alias — an operator's hand-made
 * `agents/<id>/workspace -> workspaces/<id>`, or this migration's own
 * recreate-then-unlink for a relative link, interrupted. So can the
 * *ledger file alone*, with two real workspace directories: a link at the
 * file rather than at the directory is a layout `ledgerGuard` deliberately
 * recognises, so it is one this migration has to expect.
 *
 * Identity rather than spelling, which also answers a hard link — the other
 * shape `ledgerGuard` tracks, and one no amount of `realpath` would reveal.
 */
const sameEntry = async (a: string, b: string): Promise<boolean> => {
  try {
    const [left, right] = await Promise.all([stat(a), stat(b)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    // One of them cannot be resolved, so they are not the same thing that
    // is there. The caller's next step decides what that means.
    return false;
  }
};

/**
 * Rewrite a moved workspace's ledger to name where its files now are, and
 * drop the marker that said it still had to be done.
 *
 * The spellings are the *source's* — the paths the records were written
 * against — and the destination is spelled the way a read will spell it.
 * Idempotent: a second pass finds those records already reparented, so
 * `reparented` declines them and the rewrite is a no-op.
 */
const finishMove = async (workspace: string, from: readonly string[], target: string): Promise<void> => {
  await remapLedger(workspace, from, (await spellingsOf(target, 'self')).at(-1)!);
  await clearMoveMarker(workspace);
};

/**
 * Finish any move whose rename landed but whose ledger rewrite did not.
 *
 * Runs before the legacy directory is walked, because by then there may be
 * nothing left there to notice: the workspace is already at its new path,
 * and only the marker inside it says its records still name the old one.
 * Without this the migration would stamp over a ledger pointing at paths
 * nothing is at, which is every one of those files reading back as the
 * agent's own words.
 */
const finishInterruptedMoves = async (env: StateEnvironment): Promise<number> => {
  let entries: Dirent[];
  try {
    entries = await readdir(agentsDirPath(env), { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 0;
    }
    throw error;
  }
  let finished = 0;
  for (const entry of entries) {
    // Directories whose name could be an agent's, for the reason
    // `createAgentWorkspaces` gives: this is a listing, not a roster, and
    // `agentWorkspacePath` refuses a name that is not a path segment.
    if (!entry.isDirectory() || !isValidAgentId(entry.name)) {
      continue;
    }
    const workspace = agentWorkspacePath(env, entry.name);
    const from = await readMoveMarker(workspace);
    if (from === undefined) {
      continue;
    }
    await finishMove(workspace, from, workspace);
    finished += 1;
  }
  return finished;
};

/**
 * Move each `workspaces/<id>` into `agents/<id>/workspace`.
 *
 * Idempotent and restartable at every agent: one rename each, a ledger
 * rewrite after it, and an agent whose directory cannot be made is named
 * and skipped rather than aborting the fleet.
 */
export const applyPerAgentWorkspaces = async (env: StateEnvironment): Promise<string | undefined> => {
  // Before anything else: a previous run may have moved a workspace and
  // died before its ledger followed, and there is nothing in `workspaces/`
  // left to say so.
  const finished = await finishInterruptedMoves(env);
  const legacy = legacyWorkspacesDirPath(env);
  let entries: Dirent[];
  try {
    entries = await readdir(legacy, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Not there, or not a directory: either way it holds no workspaces.
    // `ENOTDIR` is a regular file somebody left at that name — aborting
    // over it would refuse every `stratus serve` for good, since the
    // migration that would clear the obstacle is the one failing.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return finished > 0 ? `finished ${finished} interrupted workspace move(s)` : undefined;
    }
    throw error;
  }
  /**
   * Where a path inside the legacy workspaces directory is going, or
   * undefined when it is not one this migration relocates.
   *
   * Only a first segment that could be an agent id: anything else stays
   * where it is, so a link to it is right as it stands. A workspace this
   * run ends up quarantining is the one case this gets wrong, and it is
   * the better way round — the overwhelmingly likely outcome is that the
   * other workspace moves, and a link left naming `workspaces/<id>` would
   * then dangle.
   */
  const migratedTarget = (resolved: string): string | undefined => {
    const relative = path.relative(legacy, resolved);
    if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    const [other, ...rest] = relative.split(path.sep);
    if (other === undefined || !isValidAgentId(other)) {
      return undefined;
    }
    return path.join(agentWorkspacePath(env, other), ...rest);
  };
  const report: WorkspaceMigrationReport = {
    moved: 0,
    merged: [],
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
      // it is, which loses nothing: nothing is deleted, and an operator who
      // renames the agent gets the move on the next `stratus update`.
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
    // `lstat`, not `readdir` or `stat`: a *dangling* symlink at the
    // destination is something there, and both of those report it as
    // ENOENT. Renaming a directory over it would fail — after this
    // migration had decided the name was free.
    if (!(await pathIsFree(target))) {
      const here = path.relative(stratusHomePath(env), from);
      const there = path.relative(stratusHomePath(env), target);
      // The destination may be a link back to this very workspace, in which
      // case there is one directory and one ledger and nothing to fold —
      // see `sameEntry` for what folding a ledger into itself costs.
      // Already reachable at the new path, so this is a finished state and
      // not a collision.
      if (await sameEntry(from, target)) {
        report.quarantined.push(`${agentId} — ${there} already resolves to ${here}, so it was left as it is`);
        continue;
      }
      // Otherwise the deferral window, and the ordinary outcome of running
      // any command before restarting the daemon — see the note at the top
      // on why this merges rather than refuses. Nothing has to be undone
      // first: a ledger is rewritten only *after* its rename has already
      // succeeded, so the records here still name where their files are.
      await clearMoveMarker(from);
      const folded = await foldLedgerInto(from, target);
      if (folded === 'folded') {
        report.merged.push(agentId);
      }
      const why = folded === 'unreachable'
        ? `something is at ${there} that its provenance records cannot be written into, so ${here} was left `
          + 'untouched; its ledger is the only copy of those labels'
        : folded === 'aliased'
          ? `${there} already reads the very ledger in ${here}, so there was nothing to fold; both are left `
            + 'as they are'
          : `${there} already existed, so what is left of ${here} stays there; its provenance records were `
            + 'folded into the ledger at the new path, and the files they name have not moved';
      report.quarantined.push(`${agentId} — ${why}`);
      continue;
    }
    // Captured while the source is still there: `realpath` cannot answer for
    // it once it has moved, and on a home reached through a link the
    // canonical spelling is the one its ledger records were written as.
    let fromSpellings: readonly string[] = [];
    if (!entry.isSymbolicLink()) {
      // Everything fallible happens while the source is still there, and
      // that is the ordering rule this whole block is written to: a step
      // that fails *after* the rename cannot be retried, because the next
      // run finds no legacy entry, stamps 0004, and leaves whatever that
      // step was going to fix undone for good.
      //
      // The ledger itself is *not* rewritten here. Its records have to name
      // where their files are, and until the rename lands that is the old
      // path — a ledger rewritten for a move that then failed is a set of
      // labels pointing at nothing, and no later pass can tell those apart
      // from records that legitimately name the destination. A pre-layout
      // build records every `fs.write` under the agent's configured roots,
      // and one of those roots can cover `agents/<id>/workspace` once
      // something creates it, so "a destination path in this ledger means
      // an interrupted move" is a guess, not an invariant.
      //
      // What goes here instead is the marker: the note saying which path
      // this workspace is moving from, so the rewrite can happen *after*
      // the rename, when it is unambiguously right, and still be finished
      // by a later run if this one dies in between.
      fromSpellings = await spellingsOf(from, 'self');
      await writeMoveMarker(from, fromSpellings);
      // Then the mode, on the source because a `chmod` failing after the
      // rename would abort a migration whose source is already gone.
      // `agents/<id>/` is already owner-only, so this changes nothing an
      // attacker could reach today — it is for the workspace read through a
      // path that is not this one.
      await chmod(from, 0o700);
    }
    // A link's own files do not move, so nothing above applies to one: its
    // records still name where they are, and `chmod` would follow the link
    // and set the mode of whatever an operator pointed it at.
    //
    // Two things do apply. A *relative* link is not moved by a rename at
    // all: its target resolves against the directory holding it, and this
    // move changes that directory, so `workspaces/ava -> ../../data/ava`
    // means `~/data/ava` where it is and `~/.stratus/data/ava` once it sits
    // at `agents/ava/workspace`. And a link pointing *into the legacy
    // workspaces directory* — `workspaces/ava -> bea` — names something
    // this very loop relocates, so preserving where it points today leaves
    // it dangling whichever order the two are reached in. Such a target is
    // followed to where its workspace is going instead.
    const moveIntoPlace = async (): Promise<void> => {
      if (entry.isSymbolicLink()) {
        const text = await readlink(from);
        const resolved = migratedTarget(path.resolve(path.dirname(from), text));
        if (!path.isAbsolute(text) || resolved !== undefined) {
          await symlink(
            path.relative(path.dirname(target), resolved ?? path.resolve(path.dirname(from), text)),
            target,
          );
          // Both exist for an instant. A run killed here finds the source
          // again next time and the destination resolving to the same
          // directory, which `sameEntry` above reads as finished.
          await unlink(from);
          return;
        }
      }
      await rename(from, target);
    };
    try {
      await moveIntoPlace();
      // Now, and only now, is the rewrite unambiguous: the files are at the
      // destination, so the records naming the source are exactly the ones
      // that have to follow. A failure here leaves the marker, and
      // `finishInterruptedMoves` completes it on the next run.
      //
      // Nothing to do for a link, which moved no files and wrote no marker.
      if (fromSpellings.length > 0) {
        await finishMove(target, fromSpellings, target);
      }
    } catch (error) {
      // Nothing to undo: the ledger was never touched, because it is only
      // rewritten once the move has landed. The marker is dropped so a
      // later run does not read it as a move that got further than it did.
      await clearMoveMarker(from);
      // Loud, and not quarantined, which is the opposite of how an id with
      // nowhere to land is treated — because the consequence is opposite
      // too. A workspace half-moved is a ledger whose records name files
      // that are no longer where they say, which is a set of labels gone
      // silently. A daemon that will not start says so and can be fixed by
      // hand.
      //
      // `EXDEV` is one that happens: a workspace an operator mounted rather
      // than linked cannot be renamed across the mount. So is `ENOTEMPTY`,
      // when an ordinary command created the destination between the check
      // and here.
      throw new Error(
        `Could not move ${JSON.stringify(agentId)}'s workspace from ${from} to ${target} `
        + `(${(error as NodeJS.ErrnoException).code ?? 'unknown error'}). It holds that agent's provenance `
        + 'ledger, so it is not safe to leave behind: move the directory by hand, or replace a mount at '
        + 'that path with a symlink, and run `stratus update` again.',
      );
    }
    report.moved += 1;
  }
  // Only when it empties, and never recursively: an operator's own file in
  // here is theirs, and a workspace left behind is that agent's output.
  try {
    await rmdir(legacy);
  } catch {
    // Still holding something. Nothing to report: what is left is either
    // named above or was never this migration's.
  }
  if (report.moved === 0 && report.quarantined.length === 0 && finished === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (report.moved > 0) {
    parts.push(`moved ${report.moved} workspace(s)`);
  }
  if (finished > 0) {
    parts.push(`finished ${finished} interrupted move(s)`);
  }
  if (report.merged.length > 0) {
    parts.push(`folded ${report.merged.length} provenance ledger(s) into a workspace already at the new path`);
  }
  const summary = parts.length > 0 ? parts.join('; ') : 'moved nothing';
  return report.quarantined.length > 0
    ? `${summary}; LEFT IN ${path.basename(legacy)}/: ${report.quarantined.join('; ')}`
    : summary;
};
