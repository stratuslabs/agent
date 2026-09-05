import { constants } from 'node:fs';
import { appendFile, chmod, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
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
    // record for a path stands whichever process appended first. A label
    // nobody recognises is no record.
    if (isTrustLevel(record.trust) && tainted(record.trust)) {
      const recorded = paths[record.path!];
      paths[record.path!] = recorded !== undefined ? leastTrusted(recorded, record.trust) : record.trust;
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
 * `<workspaceRoot>/<agentId>/fs-provenance.jsonl`, owner-only. Each record
 * is one `O_APPEND` write, so processes that share an agent — the daemon and
 * a `stratus run` — interleave records rather than overwrite each other.
 */
export const createFileLedger = (workspaceRoot: string): TaintedWriteLedger => {
  const ledgerPath = (agentId: string): string => path.join(workspaceRoot, agentId, LEDGER_FILENAME);

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
        const filePath = ledgerPath(agentId);
        const before = await read(agentId);
        const paths = nextPaths(before, absolutePath, trust);
        // A clean write records nothing, and a path already at this label
        // or lower needs no second line — so a host whose workspace root is
        // unwritable fails only the writes that needed the ledger.
        if (paths === before) {
          return;
        }
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        // Tightened before the append, like the memory file: `appendFile`'s
        // mode applies only when it creates the file.
        try {
          await chmod(filePath, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        const record: LedgerRecord = {
          path: absolutePath,
          trust: paths[absolutePath]!,
          at: new Date().toISOString(),
        };
        await appendFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      });
      chain = work.then(() => undefined, () => undefined);
      return work;
    },
  };
};

/**
 * Whether `absolutePath` is an agent's ledger — exactly
 * `<workspaceRoot>/<agentId>/fs-provenance.json`, any agent's — which is the
 * one path `fs.write` refuses. Exactly that depth, not any descendant with
 * the name: a project an agent keeps under its workspace may legitimately
 * have a file called `fs-provenance.json` of its own.
 *
 * `workspaceRoots` are every spelling of the workspace root worth checking
 * — the configured path and its canonical form — because the path being
 * judged arrives canonical from the root resolver, and a workspace an
 * operator moved behind a symlink would otherwise compare as outside.
 */
export const isLedgerPath = (workspaceRoots: readonly string[], absolutePath: string): boolean =>
  workspaceRoots.some((workspaceRoot) => {
    const relative = path.relative(workspaceRoot, absolutePath);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }
    const segments = relative.split(path.sep);
    return segments.length === 2 && segments[1] === LEDGER_FILENAME;
  });

/**
 * The predicate `fs.write` refuses on and `fs.read` labels by, built once
 * per tool call from what the workspace holds right now. A path is an
 * agent's ledger two ways: lexically —
 * `<workspaceRoot>/<agent>/fs-provenance.jsonl` under the configured or the
 * canonical root — or through a link at the agent directory. An operator
 * who relocated one agent's workspace with `<workspaceRoot>/ava -> /data/ava`
 * has the ledger at `/data/ava/fs-provenance.jsonl`, which is how the root
 * resolver spells every path under it and which no spelling of the root
 * reaches, so every entry of the workspace is canonicalized and its ledger
 * path listed — the ledger file's own canonical path too, for a link at
 * the file rather than the directory, and its device and inode, for a hard
 * link to it from inside a root. Built per call and never cached: a
 * link repointed under a running daemon is judged where it points now, and
 * one `readdir` plus two `realpath`s per agent is nothing next to the write.
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

export const ledgerGuard = async (workspaceRoot: string | undefined): Promise<LedgerGuard> => {
  if (workspaceRoot === undefined) {
    return async () => false;
  }
  const roots = [workspaceRoot];
  try {
    const canonical = await realpath(workspaceRoot);
    if (canonical !== workspaceRoot) {
      roots.push(canonical);
    }
  } catch {
    // Not there yet: only the configured spelling, and no agents to list.
  }
  const ledgers = new Set<string>();
  // And the files themselves, by identity: a hard link to a ledger from
  // inside a root has a path no spelling reaches and `realpath` leaves
  // alone, and is the same bytes. Plain numbers, like the resolver's
  // `identity`, so the two sides of a comparison round the same way.
  const identities = new Set<string>();
  let entries: Dirent[] = [];
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const lexical = path.join(workspaceRoot, entry.name, LEDGER_FILENAME);
    // Two canonical spellings, because either component can be a link: the
    // agent directory (`ava -> /data/ava`, judged even before the ledger
    // exists there) and the ledger file itself (`fs-provenance.jsonl ->
    // /data/ava-ledger.jsonl`, whose target is what the resolver returns
    // and what a truncating write would empty).
    try {
      ledgers.add(path.join(await realpath(path.dirname(lexical)), LEDGER_FILENAME));
    } catch {
      // A dangling link holds no ledger.
    }
    try {
      ledgers.add(await realpath(lexical));
      identities.add(identityKey(await stat(lexical)));
    } catch {
      // No ledger there yet, or a dangling link: nothing to protect.
    }
  }
  return async (absolutePath, identity) => {
    if (isLedgerPath(roots, absolutePath) || ledgers.has(absolutePath)) {
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
