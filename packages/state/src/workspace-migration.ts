import { randomUUID } from 'node:crypto';
import { type Dirent } from 'node:fs';
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
  agentStateDirPath,
  agentWorkspacePath,
  agentsDirPath,
  legacyAgentWorkspaceIn,
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
//   the far side of an irreversible rename finishable is that it is
//   derived rather than remembered: see `finishInterruptedMoves`.
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
 * Every spelling of a path that a ledger record could be written as: the one
 * given, and its canonical form.
 *
 * The ledger is keyed the way `fs.read` looks a path up, through `realpath`,
 * and `~/.stratus` may itself be a symlink — so a record names the canonical
 * path while this migration walks the configured one.
 *
 * Absence is the one failure that answers: nothing there has no second
 * spelling, and a caller asking about a workspace that is not there has
 * nothing to re-record either way. Every other failure propagates, because
 * losing the canonical spelling on a linked home is not a smaller answer —
 * it is `remapLedger` matching none of that agent's records while the move
 * goes ahead and 0004 stamps over it.
 */
const spellingsOf = async (target: string): Promise<string[]> => {
  const spellings = [target];
  try {
    const canonical = await realpath(target);
    if (canonical !== target) {
      spellings.push(canonical);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw error;
    }
  }
  return spellings;
};

/**
 * Every spelling of where an agent's workspace used to be.
 *
 * Built from the home rather than from `workspaces/` itself, because by the
 * time the repair asks, `workspaces/` is usually gone — and `realpath` of a
 * path that is not there answers nothing, which would drop exactly the
 * canonical spelling the records were written as on a home reached through
 * a link. The home is still there; the rest is a join.
 */
const legacyWorkspaceSpellings = async (env: StateEnvironment, agentId: string): Promise<string[]> => {
  const home = stratusHomePath(env);
  const spellings = [legacyAgentWorkspaceIn(home, agentId)];
  try {
    const canonical = legacyAgentWorkspaceIn(await realpath(home), agentId);
    if (!spellings.includes(canonical)) {
      spellings.push(canonical);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // No home to canonicalize means no install; anything else is a reason
    // to stop rather than repair half the records.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw error;
    }
  }
  return spellings;
};

/**
 * Where a link points, or undefined when the path is not a link at all or
 * is not there.
 *
 * Those two are answers; everything else is a failure, and a failure read
 * as "not a link" is this migration deciding a question by not being able
 * to ask it. Both callers turn undefined into "carry on as though this
 * were an ordinary directory", which is the wrong direction for each.
 */
const linkText = async (filePath: string): Promise<string | undefined> => {
  try {
    return await readlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EINVAL' || code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
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
 * The destination appeared between the last check and the rename. Its own
 * type because the catch that wraps every other failure would tell the
 * operator to move a directory by hand, and the fix here is to run the
 * upgrade again — nothing of this agent's has moved. Internal: the only
 * caller that catches it is the one that throws it.
 */
class WorkspaceDestinationTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceDestinationTakenError';
  }
}

/** Whether a path leads to something, following links. A dangling one does not. */
const resolves = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
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
 * Re-record, at the workspace's new path, everything the ledger had recorded
 * at its old one.
 *
 * A ledger record is an absolute path, so a rename silently invalidates
 * every record naming a file inside the workspace — and `plugin-mcp` puts
 * every binary a server returns at `<workspace>/mcp/<server>/…` and records
 * it there, so this is the common case rather than a corner of it. A record
 * whose path is outside the workspace — the agent's ordinary `fs` roots,
 * which is most of them — is nothing to do with this.
 *
 * **Appended, not rewritten**, and that is the whole design. The obvious
 * shape is read the file, edit the paths, write it back; but this migration
 * does not have the ledger to itself. Ordinary commands take no home lock,
 * deliberately, and the moment the rename exposes the new path one of them
 * can append a record there. A read-modify-write would drop whatever landed
 * between its read and its rename, and a dropped record is an externally
 * sourced file reading back as the agent's own words — permanently, since
 * the migration stamps afterwards.
 *
 * An append cannot lose one. It also needs no exclusivity to be correct,
 * because the format was built for concurrent appenders: `parseLedger` keeps
 * the lowest label recorded for a path whichever process wrote it first.
 *
 * What it leaves behind is the old record, naming a path nothing is at any
 * more. That costs a line each and is the safe direction: a stale record can
 * only ever *add* a label to a path, never remove one.
 *
 * Lines that will not parse are left alone. The reader refuses such a ledger
 * and says to delete it; this migration has no opinion about one that was
 * already broken.
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
  const moved: string[] = [];
  // What the ledger already says, as `path` and label together. A repair
  // that is derived rather than remembered can run more than once — the
  // migration is retried whenever a run fails before stamping — and without
  // this each pass would append the same re-recordings again. Appending a
  // record whose label is *new* is still right, so the pair is the key
  // rather than the path.
  const already = new Set<string>();
  const records: Array<{ path: string; [key: string]: unknown }> = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      continue;
    }
    const record = parsed as { path?: unknown; trust?: unknown };
    if (typeof record.path !== 'string') {
      continue;
    }
    already.add(`${record.path}\u0000${String(record.trust)}`);
    records.push(record as { path: string });
  }
  for (const record of records) {
    const at = reparented(record.path, from, to);
    if (at === undefined || already.has(`${at}\u0000${String(record.trust)}`)) {
      continue;
    }
    // Spread first, so every other field a record carries — the label, the
    // timestamp, anything a newer build writes — comes along with the path.
    moved.push(JSON.stringify({ ...record, path: at }));
  }
  if (moved.length === 0) {
    return 0;
  }
  // The rule the memory store owns: an append onto a file whose last byte is
  // not a newline fuses two records into one unparseable line, and for a
  // ledger that is a refusal to read any of it.
  const lead = await memoryAppendNeedsNewline(ledgerPath) ? '\n' : '';
  await appendFile(ledgerPath, `${lead}${moved.join('\n')}\n`, { mode: 0o600 });
  await chmod(ledgerPath, 0o600);
  return moved.length;
};

/**
 * What a fold did, for the line the report gives the operator.
 *
 * `dropped` is only ever non-zero alongside `folded`, and it is worth
 * saying out loud rather than returning silently: a ledger nobody could
 * read is exactly the state an operator is entitled to hear about, and the
 * bytes it held are still in the archive beside it.
 */
interface FoldResult {
  outcome: 'none' | 'folded' | 'aliased' | 'unreachable';
  dropped: number;
}

/**
 * The lines of a source ledger that are safe to append to another one.
 *
 * `parseLedger` throws on the *first* line it cannot parse and refuses the
 * whole file — so copying a torn line out of a broken ledger and into a
 * working one does not merely carry the damage across, it spreads it: every
 * `fs.read` and every `fs.write` for that agent would start failing on a
 * ledger that read fine a moment ago. One interrupted append in the legacy
 * workspace is all it takes, and that is the likeliest thing to be wrong
 * with a file this migration finds abandoned.
 *
 * Dropping the line loses whatever label it carried, which is the honest
 * trade: it carried none that anything could read, since the ledger holding
 * it was already refused in full. `remapLedger` takes the same position on
 * the same lines — this migration has no opinion about a ledger that was
 * already broken — and the archive keeps the original bytes either way.
 *
 * Records that parse but carry nothing this build recognises are copied
 * across untouched. `parseLedger` skips those without complaint, and a
 * field a newer build writes is not ours to discard.
 */
const foldableLines = (raw: string): { body: string; dropped: number } => {
  let dropped = 0;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      JSON.parse(line);
    } catch {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { body: kept.length > 0 ? `${kept.join('\n')}\n` : '', dropped };
};

/** Append records onto a ledger, leaving it owner-only and parseable. */
const appendRecords = async (destination: string, body: string): Promise<void> => {
  // The rule the memory store already owns: an append onto a file whose
  // last byte is not a newline fuses two records into one unparseable
  // line — which, for a ledger, is a refusal to read any of it.
  const lead = await memoryAppendNeedsNewline(destination) ? '\n' : '';
  await appendFile(destination, `${lead}${body}`, { mode: 0o600 });
  await chmod(destination, 0o600);
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
 *
 * **Read twice**, because the first read is not a snapshot of anything
 * that has stopped. An older build resolves `workspaces/<id>` by pathname
 * and appends there on every tainted write, ordinary commands take no home
 * lock, and a record that lands after the read is only in the source — a
 * file the collided agent no longer consults, so the label is gone for
 * good once 0004 stamps.
 *
 * The second read narrows that window; it does not close it, and nothing
 * here can. Retiring the source shuts the *name*, but `recordWrite` holds
 * one descriptor across its read and its append — deliberately, so a
 * relocated ledger resolves once — and a writer already inside that window
 * appends to the archive after the rename. Where the source stays live
 * because another agent shares it, there is not even a name to shut.
 *
 * Nor does the exclusive bracket close it. That bracket keeps *other
 * migrations* off the home; ordinary commands take no home lock at all,
 * deliberately — see `layout-migration.ts` — so an older build's command
 * is exactly what can be writing here, and nothing this function orders
 * will stop it. What the second read buys is that the window is the gap
 * between two reads rather than the whole fold.
 */
const foldLedgerInto = async (
  from: string,
  target: string,
  retire: boolean,
): Promise<FoldResult> => {
  const source = ledgerIn(from);
  // The destination's ledger can be this very file under another name, with
  // two real workspace directories on either side of it — see `sameEntry`.
  // Nothing to fold: the records are already live where a read will look.
  if (await sameEntry(source, ledgerIn(target))) {
    return { outcome: 'aliased', dropped: 0 };
  }
  let raw: Buffer;
  try {
    raw = await readFile(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { outcome: 'none', dropped: 0 };
    }
    throw error;
  }
  const destination = ledgerIn(target);
  // Bytes, not characters: this offset indexes back into a file on disk.
  const complete = raw.lastIndexOf(0x0a) + 1;
  let dropped = 0;
  const first = foldableLines(raw.subarray(0, complete).toString('utf8'));
  dropped += first.dropped;
  if (first.body.length > 0) {
    try {
      await appendRecords(destination, first.body);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Something is at the destination — `pathIsFree` said so — but it is
      // not a directory these records can be written into: a dangling link
      // is the shape that reaches here. The source keeps its ledger, which
      // is the only copy of those labels, and the agent is named.
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { outcome: 'unreachable', dropped: 0 };
      }
      throw error;
    }
  }
  /**
   * Whatever landed in the source after the read above — a legacy command
   * appending while this ran. Reading the ledger of a fleet that has been
   * up for months is not instant, and a record that lands inside that read
   * is only in the source, which the collided agent no longer consults.
   *
   * Resumed from `complete` rather than from the end of what was read, so
   * a record caught mid-append is recovered whole rather than split across
   * the two reads and dropped by both halves.
   *
   * Not guarded the way the first append is: the destination took records
   * a moment ago, and a failure here is a fold left half done, which this
   * migration throws on rather than stamping over.
   */
  const foldRest = async (at: string): Promise<void> => {
    const late = await readFile(at);
    if (late.length <= complete) {
      return;
    }
    const rest = foldableLines(late.subarray(complete).toString('utf8'));
    dropped += rest.dropped;
    if (rest.body.length > 0) {
      await appendRecords(destination, rest.body);
    }
  };
  if (!retire) {
    // Somebody else is still reading this file — see `ledgerIsShared`.
    // Copied rather than moved, then: the duplicate records resolve to the
    // same labels wherever they are read, and the alternative is taking an
    // agent's whole ledger away to migrate a different agent.
    await foldRest(source);
    return { outcome: 'folded', dropped };
  }
  // Never over an archive already there: a run killed between the append
  // and this rename leaves one, and the retry must not bury it.
  const candidate = `${source}.migrated`;
  const archive = await pathIsFree(candidate) ? candidate : `${candidate}-${randomUUID()}`;
  await rename(source, archive);
  await foldRest(archive);
  return { outcome: 'folded', dropped };
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Nothing there — a dangling link is the usual one — so they are not the
    // same thing, and the caller's next step decides what that means.
    // Anything else is "cannot tell", and answering no to that folds a
    // ledger that may be the very file it is being folded into.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
};

/**
 * Whether any other workspace on this host reads this same ledger.
 *
 * Asked before a fold retires the source's ledger, because retiring it is
 * only safe if nothing else is still reading it. Two agents can share one
 * workspace — `workspaces/ava` and `workspaces/bea` both linked at
 * `/data/shared` is a layout an operator can build today, and the ledger
 * format tolerates it, since records are keyed by absolute path and labels
 * only ever go down. The sharing can also be at the file alone —
 * `bea/fs-provenance.jsonl` a link to `ava`'s, two real workspaces either
 * side of it — which is a shape `ledgerGuard` already recognises and so
 * one this has to expect. Folding one of those agents into a destination that
 * already exists would then archive the *shared* ledger, and the other
 * agent — migrated as a link to the same directory, with no collision of
 * its own — would come out the far side with no ledger at all and every
 * externally sourced file in it reading back as its own words.
 *
 * Both sides are looked at, because either order reaches the same place:
 * an agent still waiting in `workspaces/` has its legacy entry, and one
 * already moved has `agents/<id>/workspace`. Identity, not spelling — the
 * sharing is a link by construction, so comparing paths would find nothing.
 */
const ledgerIsShared = async (env: StateEnvironment, from: string): Promise<boolean> => {
  const candidates: string[] = [];
  // Absence is an answer — nothing there is nothing to share it with — and
  // every other failure is "cannot tell", which must not read as "nobody
  // else has it". A directory that is searchable but not listable, or a
  // transient `EMFILE`, would otherwise retire a ledger an agent this walk
  // never saw is still reading, and 0004 stamps over that.
  const listed = async <T>(work: Promise<T[]>): Promise<T[]> => {
    try {
      return await work;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return [];
      }
      throw error;
    }
  };
  for (const name of await listed(readdir(legacyWorkspacesDirPath(env)))) {
    candidates.push(path.join(legacyWorkspacesDirPath(env), name));
  }
  for (const entry of await listed(readdir(agentsDirPath(env), { withFileTypes: true }))) {
    if (entry.isDirectory() && isValidAgentId(entry.name)) {
      candidates.push(agentWorkspacePath(env, entry.name));
    }
  }
  for (const candidate of candidates) {
    if (candidate === from) {
      continue;
    }
    // The directory, and the ledger file on its own: a link at the file
    // rather than at the directory shares exactly what is about to be
    // retired, and comparing only directories misses it entirely.
    if (await sameEntry(candidate, from) || await sameEntry(ledgerIn(candidate), ledgerIn(from))) {
      return true;
    }
  }
  return false;
};

/**
 * Rewrite a moved workspace's ledger to name where its files now are.
 *
 * The spellings are the *source's* — the paths the records were written
 * against — and the destination is spelled the way a read will spell it.
 */
const finishMove = async (
  workspace: string,
  from: readonly string[],
  target: string,
): Promise<void> => {
  await remapLedger(workspace, from, (await spellingsOf(target)).at(-1)!);
};

/**
 * Finish any move whose rename landed but whose ledger rewrite did not.
 *
 * Runs before the legacy directory is walked, because by then there may be
 * nothing left there to notice: the workspace is already at its new path
 * and its records still name the old one.
 *
 * **Derived from the state on disk, never from a note left behind.** A note
 * was the obvious design and it was wrong twice over: whatever file said
 * "this one still needs repairing" would be one an agent could edit — and
 * then, once it was moved out of the workspace, one an agent could still
 * delete, because `shell.run`'s cwd is a starting directory and not a jail
 * (`tool-shell`'s README says so in as many words). A note that can be
 * removed is a repair that can be skipped, and a skipped repair is every
 * file that agent fetched from outside reading back as its own words.
 *
 * The state says it instead, and cannot be unsaid: the workspace is at the
 * new path, its legacy entry is gone, and the ledger still holds records
 * naming that legacy path. Re-recording them is what the repair *is*, so
 * running it whenever those conditions hold needs no memory of having
 * started. It costs one ledger read per agent on the one run this migration
 * gets.
 *
 * Unconditionally safe to repeat, and safe when it is not a move at all: a
 * fresh agent's ledger holds no record under `workspaces/<id>` and the pass
 * does nothing. The one case it cannot tell apart is an operator whose `fs`
 * roots covered `~/.stratus/workspaces` and whose agent wrote there
 * directly; that agent gains a label on a path under its new workspace
 * which may hold something else. Labels only ever go down, so the cost is
 * one file read back more cautiously than it needs to be — the direction
 * this migration errs in everywhere else too.
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
    // The legacy entry still being there means the rename has not happened,
    // and that agent is the ordinary walk's to move — not this pass's to
    // repair. Repairing it here would put destination-named records in a
    // ledger whose files are still at the old path.
    if (!(await pathIsFree(legacyAgentWorkspaceIn(stratusHomePath(env), entry.name)))) {
      continue;
    }
    // Where it came from is derived: `workspaces/<id>`, with the id taken
    // from the directory this loop is standing in, in both the spelling
    // the home is configured with and the one `realpath` gives it.
    const workspace = agentWorkspacePath(env, entry.name);
    const from = await legacyWorkspaceSpellings(env, entry.name);
    if (await remapLedger(workspace, from, (await spellingsOf(workspace)).at(-1)!) > 0) {
      finished += 1;
    }
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
    // Only a workspace this run actually moved. One that was quarantined or
    // whose ledger was folded is still at its legacy path, and a link to it
    // is right as it stands.
    if (other === undefined || !moved.has(other)) {
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
  // Real workspaces first, links second, and the order is load-bearing: a
  // link into this directory can only be pointed at where its workspace
  // ended up once that is known. A workspace whose destination was already
  // occupied stays where it is and its ledger is folded, so a link to it
  // must keep naming the old path — sending it to `agents/<other>/workspace`
  // would silently swap the shared files for a different workspace that an
  // ordinary command happened to create.
  const moved = new Set<string>();
  /**
   * Whether `target` holds the link this migration would have written for
   * `from` — which only the recreate step writes.
   *
   * That step maps a source link naming another legacy workspace to where
   * that workspace went, so the evidence is exactly this: the source names
   * `workspaces/<other>`, and the destination names
   * `agents/<other>/workspace`. Nothing else in the layout produces that
   * pair, and a link to a volume that happens to be unmounted produces
   * neither half of it.
   *
   * Spelling is not compared, resolution is not required: the destination
   * link is read and its target resolved as a path, because the workspace
   * it names may be absent for the same reason the source is.
   */
  const destinationIsOurRecreate = async (from: string, target: string): Promise<boolean> => {
    const [sourceText, targetText] = await Promise.all([linkText(from), linkText(target)]);
    if (sourceText === undefined || targetText === undefined) {
      return false;
    }
    // The first segment is the workspace; anything after it is a path
    // inside it, which `migratedTarget` carries across unchanged. Checking
    // the whole string against `isValidAgentId` rejected exactly the links
    // this is meant to recognise — `workspaces/ava -> bea/subdir` recreates
    // as `agents/bea/workspace/subdir`.
    const names = path.relative(legacy, path.resolve(path.dirname(from), sourceText));
    if (path.isAbsolute(names) || names === '..' || names.startsWith(`..${path.sep}`)) {
      return false;
    }
    const [other, ...rest] = names.split(path.sep);
    if (other === undefined || !isValidAgentId(other)) {
      return false;
    }
    return path.resolve(path.dirname(target), targetText)
      === path.join(agentWorkspacePath(env, other), ...rest);
  };

  const move = async (entry: Dirent): Promise<void> => {
    if (!isWorkspaceEntry(entry)) {
      return;
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
      return;
    }
    // The agent's directory before anything under it, and through the rule
    // 0003 uses: a name that is another spelling of this id on a folding
    // filesystem would otherwise put two agents' output in one workspace.
    if (await agentDirectoryOrQuarantine(env, agentId, 'workspace', report) === undefined) {
      report.quarantined.push(`${agentId} — left at ${path.relative(stratusHomePath(env), from)}`);
      return;
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
        return;
      }
      // A source link that leads nowhere, with the destination holding the
      // link this migration itself would have written for it: the shape a
      // run killed between recreating a link and unlinking its source
      // leaves — `ava -> bea -> cyd`, cyd moved, bea's destination written,
      // bea's source now dangling because `workspaces/cyd` has gone.
      //
      // Counted as moved even though this run did not move it, because
      // that set is what `migratedTarget` reads, and a dependent asking
      // where this agent's workspace went has to be told the new path.
      // Reading the dangling source instead would point it at a directory
      // nothing is at — and unlike a label, that is a link an operator can
      // see. The stale source is left alone rather than unlinked: it is
      // still theirs, and a target that is merely unmounted comes back.
      //
      // Proof, not inference, and the distinction is the whole of it: a
      // link to an unmounted volume also dangles, and a command in the
      // deferral window can have created `agents/<id>/workspace` for
      // reasons of its own. Taking *that* pair as a finished move would
      // silently re-aim a dependent at an unrelated directory and leave it
      // there when the volume came back.
      if (entry.isSymbolicLink() && !(await resolves(from)) && await destinationIsOurRecreate(from, target)) {
        moved.add(agentId);
        report.quarantined.push(
          `${agentId} — ${here} leads nowhere and ${there} is already there, so the new path is taken as `
          + 'this workspace and the stale link left for you to remove',
        );
        return;
      }
      // Otherwise the deferral window, and the ordinary outcome of running
      // any command before restarting the daemon — see the note at the top
      // on why this merges rather than refuses. Nothing has to be undone
      // first: a ledger is rewritten only *after* its rename has already
      // succeeded, so the records here still name where their files are.
      // Retired only if this workspace is nobody else's — see
      // `ledgerIsShared`. Asked before the fold, because the fold is
      // what would take it away.
      const shared = await ledgerIsShared(env, from);
      const folded = await foldLedgerInto(from, target, !shared);
      if (folded.outcome === 'folded') {
        report.merged.push(agentId);
      }
      // Said out loud, because a torn line means that ledger was refusing
      // every read for this agent before the migration touched it, and the
      // operator's copy of those bytes is now the archive beside it.
      const torn = folded.dropped > 0
        ? ` (${folded.dropped} line(s) no reader could parse were left behind in the archived ledger)`
        : '';
      const why = folded.outcome === 'unreachable'
        ? `something is at ${there} that its provenance records cannot be written into, so ${here} was left `
          + 'untouched; its ledger is the only copy of those labels'
        : folded.outcome === 'aliased'
          ? `${there} already reads the very ledger in ${here}, so there was nothing to fold; both are left `
            + 'as they are'
          : `${there} already existed, so what is left of ${here} stays there; its provenance records were `
            + `folded into the ledger at the new path${torn}, and the files they name have not moved`
            + (shared ? '; its own ledger was left live, because another workspace is still reading it' : '');
      report.quarantined.push(`${agentId} — ${why}`);
      return;
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
      // It happens after instead, and a run that dies in between is
      // finished by the next one from the state it left: the workspace at
      // the new path with no legacy entry beside it is the whole of the
      // evidence, and nothing an agent can unlink. See
      // `finishInterruptedMoves`.
      fromSpellings = await spellingsOf(from);
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
      // Checked again, as late as it can be. `rename` onto an *empty*
      // directory succeeds and unlinks it — so an ordinary command that
      // created the destination since the check above, and is sitting in
      // it as `shell.run`'s cwd, would go on writing into a directory with
      // no name, and every file it produced would be gone with 0004
      // stamped over it. There is no `RENAME_NOREPLACE` in Node, so this
      // narrows the window to a single syscall rather than closing it, and
      // nothing available closes it: the exclusive bracket holds off other
      // migrations, not the lock-free ordinary commands that create this
      // path, and a `mkdir` reservation is atomic for *detecting* the
      // collision but renames onto its own directory with the same replace
      // semantics.
      if (!(await pathIsFree(target))) {
        throw new WorkspaceDestinationTakenError(
          `${target} appeared while ${JSON.stringify(agentId)}'s workspace was being moved into it, so the `
          + 'move was stopped rather than replacing it — a command of yours is most likely writing there '
          + 'right now. Nothing was changed. Run `stratus update` again once it has finished, and the two '
          + 'will be merged.',
        );
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
      // Nothing to undo: the ledger is only rewritten once the move has
      // landed, and a rewrite that failed on the far side of the rename is
      // finished by the next run from what it can see.
      // Already a full sentence naming its own fix, and a different fix
      // from the one below: nothing of this agent's has moved.
      if (error instanceof WorkspaceDestinationTakenError) {
        throw error;
      }
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
    moved.add(agentId);
    report.moved += 1;
  };

  // Real workspaces first: a link can only be pointed at where its target
  // ended up once that is known.
  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    await move(entry);
  }
  // Then the links, in dependency order rather than `readdir` order, because
  // one can point at another: `ava -> bea` where `bea` is itself a link.
  // Each pass takes the links that wait on nothing still pending; when a
  // pass moves nothing, whatever is left waits on something that is never
  // going to move, so it is taken as it stands — which is right, since a
  // target that stays put is a target a link should keep naming.
  let pending = entries.filter((entry) => !entry.isDirectory() && isWorkspaceEntry(entry));
  while (pending.length > 0) {
    const names = new Set(pending.map((entry) => entry.name));
    const waiting = await Promise.all(pending.map(async (entry) => {
      // A failure that is not "this is not a link" must not read as "this
      // waits on nothing": it would move the link before its target, and
      // `migratedTarget` would then keep the legacy destination for a
      // workspace this loop relocates a moment later — a dangling link with
      // 0004 stamped over it.
      const text = await linkText(path.join(legacy, entry.name));
      if (text === undefined) {
        return false;
      }
      const relative = path.relative(legacy, path.resolve(legacy, text));
      const other = relative.split(path.sep)[0];
      return other !== undefined && other !== entry.name && names.has(other);
    }));
    const ready = pending.filter((_, index) => !waiting[index]);
    const deferred = pending.filter((_, index) => waiting[index]);
    const before = moved.size;
    for (const entry of ready.length > 0 ? ready : deferred) {
      await move(entry);
    }
    if (ready.length === 0 || (deferred.length > 0 && moved.size === before && ready.length === pending.length)) {
      break;
    }
    pending = deferred;
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
