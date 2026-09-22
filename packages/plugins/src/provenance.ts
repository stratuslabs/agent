import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { isTrustLevel, leastTrusted, type TrustLevel } from '@stratusagent/core';

/**
 * The tainted-write ledger: which paths an agent wrote while its session
 * was at `external` or `unknown`, and at which label.
 *
 * The filesystem is a laundering channel by construction — a durable store
 * the agent controls. An agent that `fs.write`s fetched text into its
 * workspace and `fs.read`s it back next week gets a file with no
 * provenance, arriving as its own notes. This closes the sequence an agent
 * can perform by itself: a write from a tainted session records the path,
 * and a later read of that path taints the reading session at the recorded
 * label.
 *
 * What it does not cover, said plainly: a copy under another name, a file a
 * different process wrote, content pasted through some path the ledger
 * never saw. Full filesystem provenance means carrying labels on bytes
 * across a surface the agent does not exclusively own, which is a different
 * project.
 *
 * One file per agent, under the agent's own workspace — next to the roots
 * `tool-fs` already resolves per call, and keyed the same way, because two
 * agents with different roots is the whole point of the per-agent block.
 * It lives in the plugin host rather than in `tool-fs` because `tool-fs`
 * is not the only plugin that puts a server's bytes on disk: `plugin-mcp`
 * writes a bridged tool's image and audio blocks into the same workspace,
 * and a file that bypassed `fs.write` would otherwise read back unlabelled.
 * Without a workspace root (a host that loaded the plugin outside the
 * loader) the ledger is process-local and says so in its name: the
 * read-back-next-week case then survives only as long as the daemon does.
 */
export interface TaintedWriteLedger {
  /** The label a read of this path carries, or undefined for a path the ledger never saw. */
  lookup(agentId: string, absolutePath: string): Promise<TrustLevel | undefined>;
  /**
   * Every recorded path and its label, for a result that names many files
   * at once — a listing, a search's matches and skips — read once rather
   * than once per file.
   */
  snapshot(agentId: string): Promise<Record<string, TrustLevel>>;
  /**
   * Record a write at the writing session's label. A record only ever goes
   * down and never clears — not even when a clean session later rewrites
   * the file whole — because the path was the tainted session's choice as
   * much as the bytes were, and because a clearing is the one record that
   * could race a tainted write from another process into leaving tainted
   * bytes unlabelled. Over-marking is the safe direction; an operator who
   * wants a path back removes its lines from the ledger by hand. A clean
   * session's write records nothing.
   */
  recordWrite(agentId: string, absolutePath: string, trust: TrustLevel): Promise<void>;
}

/** The ledger's filename inside an agent's workspace. Exported so `fs.write` can refuse to write it. */
export const LEDGER_FILENAME = 'fs-provenance.jsonl';

/**
 * One line of the ledger: a path took a label. The file is append-only and
 * labels only go down, so replay takes the lowest record for a path in any
 * order — the same concurrency model as the memory JSONL, and for the same
 * reason: the daemon and a one-shot `stratus run` can both write an agent's
 * files, and a read-modify-replace from two processes drops one side's
 * record. Two appends drop nothing, and with nothing ever clearing there is
 * no ordering between processes to get wrong either.
 */
interface LedgerRecord {
  path: string;
  trust: TrustLevel;
  at: string;
}

const tainted = (trust: TrustLevel): boolean => trust === 'external' || trust === 'unknown';

/** The ledger after a write at `trust`: the same object when nothing changed. */
const nextPaths = (
  paths: Record<string, TrustLevel>,
  absolutePath: string,
  trust: TrustLevel,
): Record<string, TrustLevel> => {
  if (!tainted(trust)) {
    return paths;
  }
  const recorded = paths[absolutePath];
  const combined = recorded !== undefined ? leastTrusted(recorded, trust) : trust;
  return combined === recorded ? paths : { ...paths, [absolutePath]: combined };
};

/** In-process only. See `TaintedWriteLedger` for when this is what a host gets. */
export const createProcessLocalLedger = (): TaintedWriteLedger => {
  const byAgent = new Map<string, Record<string, TrustLevel>>();
  return {
    async lookup(agentId, absolutePath) {
      return byAgent.get(agentId)?.[absolutePath];
    },
    async snapshot(agentId) {
      return { ...(byAgent.get(agentId) ?? {}) };
    },
    async recordWrite(agentId, absolutePath, trust) {
      byAgent.set(agentId, nextPaths(byAgent.get(agentId) ?? {}, absolutePath, trust));
    },
  };
};

const parseLedger = (raw: string, filePath: string): Record<string, TrustLevel> => {
  const paths: Record<string, TrustLevel> = {};
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`The filesystem provenance ledger has an invalid line: ${filePath}. Delete it to start over; the cost is that files written by earlier tainted sessions read as the agent's own.`);
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as LedgerRecord).path !== 'string') {
      continue;
    }
    const record = parsed as Partial<LedgerRecord>;
    // Order-independent on purpose: labels only ever go down, so the lowest
    // record for a path stands whichever process appended first. A path is
    // in the ledger because a tainted write put it there, so a record whose
    // label is missing or one nobody recognises — a hand edit, a label from
    // a newer build — still marks the path: at `unknown`, never dropped,
    // which would read the file back as the agent's own.
    const label: TrustLevel = isTrustLevel(record.trust) ? record.trust : 'unknown';
    if (tainted(label)) {
      const recorded = paths[record.path!];
      paths[record.path!] = recorded !== undefined ? leastTrusted(recorded, label) : label;
    }
  }
  return paths;
};

/**
 * The label the ledger's own contents carry: the lowest label recorded in
 * it. Every path in it was chosen by a session at `unknown` or `external`,
 * and the ledger's own path has no record, so an agent whose roots cover
 * its workspace could otherwise `fs.read` the ledger and get a list of
 * attacker-chosen filenames back at `agent`. Undefined for no file or an
 * empty one; `unknown` for a file that holds lines nothing here can read
 * — nobody vouches for those.
 */
export const ledgerContentTrust = async (
  ledgerFilePath: string,
  /**
   * The inode the caller read the ledger at. Given, the bytes judged are
   * read from that inode or not at all: a name swapped for an empty file
   * after the caller's read would otherwise be read here as "no label",
   * while the result still shows the ledger's contents. A swap reads
   * `unknown` — nobody can vouch for bytes they can no longer see.
   */
  identity?: FileIdentity,
): Promise<TrustLevel | undefined> => {
  let raw: string;
  try {
    if (identity !== undefined) {
      const handle = await open(ledgerFilePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (info.dev !== identity.dev || info.ino !== identity.ino) {
          return 'unknown';
        }
        raw = (await handle.readFile()).toString('utf8');
      } finally {
        await handle.close();
      }
    } else {
      raw = await readFile(ledgerFilePath, 'utf8');
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') {
      // With an inode in hand, a name that no longer opens is a swap too.
      return identity !== undefined ? 'unknown' : undefined;
    }
    throw error;
  }
  return ledgerTrustOfContent(raw);
};

/**
 * The label a ledger's bytes carry: the lowest recorded label, `unknown`
 * for lines nothing here can read, nothing for an empty file. Pure over the
 * bytes, so a caller that already holds what it showed the model — an
 * `fs.read` result, a search's file contents — judges exactly that, and a
 * peer rewriting the ledger in place after the read (same inode, new
 * bytes) cannot make the shown lines read as unlabelled.
 */
export const ledgerTrustOfContent = (raw: string): TrustLevel | undefined => {
  if (raw.trim().length === 0) {
    return undefined;
  }
  let labels: TrustLevel[];
  try {
    labels = Object.values(parseLedger(raw, 'the ledger as read'));
  } catch {
    return 'unknown';
  }
  return labels.length > 0 ? leastTrusted(...labels) : 'unknown';
};

/**
 * The durable ledger, one append-only JSONL file per agent at
 * `<the agent's workspace>/fs-provenance.jsonl`, owner-only. Each record is
 * one `O_APPEND` write, so processes that share an agent — the daemon and a
 * `stratus run` — interleave records rather than overwrite each other.
 *
 * Takes the resolver rather than a root, because where an agent's workspace
 * is is the host's to say: this package depends on `core` and `agents` only
 * and cannot see the `~/.stratus` layout, which is exactly why it must not
 * spell a depth. See `workspaceResolver`.
 */
export const createFileLedger = (workspaceFor: (agentId: string) => string): TaintedWriteLedger => {
  const ledgerPath = (agentId: string): string => path.join(workspaceFor(agentId), LEDGER_FILENAME);

  const read = async (agentId: string): Promise<Record<string, TrustLevel>> => {
    const filePath = ledgerPath(agentId);
    try {
      return parseLedger(await readFile(filePath, 'utf8'), filePath);
    } catch (error) {
      // No ledger yet, or a workspace root that is not a directory: either
      // way nothing has been recorded. A tainted write still fails when it
      // tries to record, which is the failure direction that leaves no
      // unlabelled file behind.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {};
      }
      throw error;
    }
  };

  // Serialized per process: two writes in one turn are rare, but a
  // read-modify-write with no lock would let the second drop the first.
  let chain: Promise<void> = Promise.resolve();

  return {
    lookup: (agentId, absolutePath) => read(agentId).then((paths) => paths[absolutePath]),
    snapshot: (agentId) => read(agentId),
    recordWrite(agentId, absolutePath, trust) {
      const work = chain.then(async () => {
        if (!tainted(trust)) {
          // A clean write records nothing — see `TaintedWriteLedger`.
          return;
        }
        const filePath = ledgerPath(agentId);
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        // Read and appended through ONE descriptor. A ledger reached through
        // a link (a relocated workspace, a relocated file — both supported)
        // is resolved once, at this open; a second open for the append
        // would resolve the name afresh, and a link repointed in between
        // would put the record in some other file while the bytes it
        // describes land where the resolver already decided. O_APPEND keeps
        // the write itself atomic against a peer's.
        const handle = await open(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND, 0o600);
        try {
          // Tightened before the append, like the memory file: the mode on
          // open applies only when it creates the file.
          await handle.chmod(0o600);
          const before = parseLedger((await handle.readFile()).toString('utf8'), filePath);
          const paths = nextPaths(before, absolutePath, trust);
          // A path already at this label or lower needs no second line.
          if (paths === before) {
            return;
          }
          const record: LedgerRecord = {
            path: absolutePath,
            trust: paths[absolutePath]!,
            at: new Date().toISOString(),
          };
          await handle.appendFile(`${JSON.stringify(record)}\n`);
        } finally {
          await handle.close();
        }
      });
      chain = work.then(() => undefined, () => undefined);
      return work;
    },
  };
};

/**
 * Whether `absolutePath` is an agent's ledger — exactly
 * `<workspace>/fs-provenance.jsonl`, for any of the workspaces given —
 * which is the one path `fs.write` refuses. Exactly that depth, not any
 * descendant with the name: a project an agent keeps under its workspace
 * may legitimately have a file called `fs-provenance.jsonl` of its own.
 *
 * `workspaces` are the directories themselves, and every spelling worth
 * checking — each configured path and its canonical form — because the path
 * being judged arrives canonical from the root resolver, and a workspace an
 * operator moved behind a symlink would otherwise compare as outside.
 *
 * Directories, not a root to join an id onto: the depth from any root to an
 * agent's workspace is the host's business, and this package cannot see it.
 * When that depth lived here it was `<root>/<agent>/`, and the move to
 * `agents/<id>/workspace/` would have left this guard silently matching
 * nothing — the one failure mode it exists to prevent.
 */
export const isLedgerPath = (workspaces: readonly string[], absolutePath: string): boolean =>
  workspaces.some((workspace) => {
    const relative = path.relative(workspace, absolutePath);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }
    const segments = relative.split(path.sep);
    return segments.length === 1 && segments[0] === LEDGER_FILENAME;
  });

/**
 * The predicate `fs.write` refuses on and `fs.read` labels by, built once
 * per tool call from what the workspaces hold right now. A path is an
 * agent's ledger two ways: lexically — `<workspace>/fs-provenance.jsonl`,
 * under the path the host gave or its canonical form — or through a link at
 * the workspace directory. An operator who relocated one agent's workspace
 * with a link has the ledger wherever it points, which is how the root
 * resolver spells every path under it and which no spelling the host gave
 * reaches, so every workspace is canonicalized and its ledger path listed —
 * the ledger file's own canonical path too, for a link at the file rather
 * than the directory, and its device and inode, for a hard link to it from
 * inside a root. Built per call and never cached: a link repointed under a
 * running daemon is judged where it points now, and two `realpath`s per
 * agent is nothing next to the write.
 *
 * Takes the workspaces themselves rather than a root to enumerate, because
 * how a root reaches an agent's workspace is the host's business — see
 * `allAgentWorkspaces`.
 */
export interface FileIdentity {
  dev: number;
  ino: number;
}

/**
 * Whether a path is an agent's ledger. `identity` is the inode the caller
 * already holds for it — captured by the root resolver and verified by the
 * open, so it is the file whose bytes were read or are about to be
 * written. Given, it is what is judged; without it the path is stat'd,
 * which names whatever is there *now*, and a peer can swap the name
 * between a read and this check.
 */
export type LedgerGuard = (absolutePath: string, identity?: FileIdentity) => Promise<boolean>;

const identityKey = (identity: FileIdentity): string => `${identity.dev}:${identity.ino}`;

/**
 * Roots whose immediate children are workspaces, judged lexically.
 *
 * This is the `workspaceRoot` contract and nothing else: one directory per
 * agent directly under the root. It is kept because a workspace that does
 * not exist *yet* still has a reserved ledger path, and enumerating what is
 * on disk cannot name it — so an agent's very first `fs.write` could create
 * or clobber `<root>/<id>/fs-provenance.jsonl` before any tainted write had
 * made the directory.
 *
 * The host's own layout gets no such rule, deliberately. There the
 * workspace sits inside `agents/<id>/`, so a root wide enough to reach an
 * agent that has no directory yet already reaches every other agent's
 * `whitelist.json` and `sessions.db` — there is nothing left for this to
 * save. Under a configured root, which holds workspaces and nothing else,
 * the reason the rule existed still holds.
 */
const isLedgerUnderRoot = (roots: readonly string[], absolutePath: string): boolean =>
  roots.some((root) => {
    const relative = path.relative(root, absolutePath);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      return false;
    }
    const segments = relative.split(path.sep);
    return segments.length === 2 && segments[1] === LEDGER_FILENAME;
  });

export const ledgerGuard = async (
  workspaces: readonly string[],
  roots: readonly string[] = [],
): Promise<LedgerGuard> => {
  if (workspaces.length === 0 && roots.length === 0) {
    return async () => false;
  }
  // Every spelling of every agent's workspace: the path the host gave and
  // its canonical form, because the path being judged arrives canonical
  // from the root resolver and a workspace behind a link would otherwise
  // compare as outside.
  const spellings: string[] = [];
  // Both spellings of each root too, for the same reason the workspaces
  // have both: the path being judged arrives canonical from the resolver.
  const rootSpellings: string[] = [];
  for (const root of roots) {
    rootSpellings.push(root);
    try {
      const canonical = await realpath(root);
      if (canonical !== root) {
        rootSpellings.push(canonical);
      }
    } catch {
      // Not there yet: only the spelling the operator gave.
    }
  }
  const ledgers = new Set<string>();
  // And the files themselves, by identity: a hard link to a ledger from
  // inside a root has a path no spelling reaches and `realpath` leaves
  // alone, and is the same bytes. Plain numbers, like the resolver's
  // `identity`, so the two sides of a comparison round the same way.
  const identities = new Set<string>();
  for (const workspace of workspaces) {
    spellings.push(workspace);
    // Two canonical spellings, because either the workspace directory or
    // the ledger file can be a link: the directory (`ava/workspace ->
    // /data/ava`, judged even before the ledger exists there) and the file
    // itself (`fs-provenance.jsonl -> /data/ava-ledger.jsonl`, whose target
    // is what the resolver returns and what a truncating write would
    // empty).
    try {
      const canonical = await realpath(workspace);
      if (canonical !== workspace) {
        spellings.push(canonical);
      }
      ledgers.add(path.join(canonical, LEDGER_FILENAME));
    } catch {
      // Not there yet, or a dangling link: holds no ledger.
    }
    const lexical = path.join(workspace, LEDGER_FILENAME);
    try {
      ledgers.add(await realpath(lexical));
      identities.add(identityKey(await stat(lexical)));
    } catch {
      // No ledger there yet, or a dangling link: nothing to protect.
    }
  }
  return async (absolutePath, identity) => {
    if (isLedgerPath(spellings, absolutePath) || isLedgerUnderRoot(rootSpellings, absolutePath) || ledgers.has(absolutePath)) {
      return true;
    }
    if (identities.size === 0) {
      return false;
    }
    if (identity !== undefined) {
      return identities.has(identityKey(identity));
    }
    try {
      return identities.has(identityKey(await stat(absolutePath)));
    } catch {
      // Nothing there: a write about to create a file is not the ledger.
      return false;
    }
  };
};

/**
 * Whether `absolutePath`, spelled exactly so and through no link, names the
 * file `handle` holds open — right now. Both halves matter: the canonical
 * spelling must be the name itself, or a directory on the way is a link and
 * the file lives somewhere else; and the inode at that name must be the
 * handle's, or the name has since been given to a decoy while the handle
 * still refers to wherever the link sent the create. A pathname comparison
 * alone passes the second case.
 */
export const nameIdentifiesHandle = async (
  absolutePath: string,
  handle: FileHandle,
): Promise<boolean> => {
  try {
    if ((await realpath(absolutePath)) !== absolutePath) {
      return false;
    }
    const [atName, held] = await Promise.all([lstat(absolutePath), handle.stat()]);
    return atName.dev === held.dev && atName.ino === held.ino;
  } catch {
    return false;
  }
};
