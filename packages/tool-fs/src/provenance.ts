import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
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
   * Record a write. A truncating write from a clean session (`user` or
   * `agent`) clears the path: the bytes there are now that session's. An
   * append keeps whatever label was recorded, since the tainted bytes are
   * still in the file, lowered further if the appending session is lower.
   */
  recordWrite(agentId: string, absolutePath: string, trust: TrustLevel, options: { append: boolean }): Promise<void>;
}

/** The ledger's filename inside an agent's workspace. Exported so `fs.write` can refuse to write it. */
export const LEDGER_FILENAME = 'fs-provenance.jsonl';

/**
 * One line of the ledger: a path took a label, or lost it (`trust: null`).
 * The file is append-only and replayed in order, so the last record for a
 * path stands — the same concurrency model as the memory JSONL, and for the
 * same reason: the daemon and a one-shot `stratus run` can both write an
 * agent's files, and a read-modify-replace from two processes drops one
 * side's record. Two appends drop nothing.
 */
interface LedgerRecord {
  path: string;
  trust: TrustLevel | null;
  at: string;
}

const tainted = (trust: TrustLevel): boolean => trust === 'external' || trust === 'unknown';

const nextPaths = (
  paths: Record<string, TrustLevel>,
  absolutePath: string,
  trust: TrustLevel,
  append: boolean,
): Record<string, TrustLevel> => {
  const recorded = paths[absolutePath];
  if (append) {
    // The old bytes are still there: the label can only go down.
    const combined = recorded !== undefined ? leastTrusted(recorded, trust) : trust;
    if (!tainted(combined)) {
      return paths;
    }
    return { ...paths, [absolutePath]: combined };
  }
  if (tainted(trust)) {
    return { ...paths, [absolutePath]: trust };
  }
  if (recorded === undefined) {
    return paths;
  }
  const { [absolutePath]: _cleared, ...rest } = paths;
  return rest;
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
    async recordWrite(agentId, absolutePath, trust, options) {
      byAgent.set(agentId, nextPaths(byAgent.get(agentId) ?? {}, absolutePath, trust, options.append));
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
    if (isTrustLevel(record.trust) && tainted(record.trust)) {
      paths[record.path!] = record.trust;
    } else {
      // A clearing, or a label nobody recognises: either way, no record.
      delete paths[record.path!];
    }
  }
  return paths;
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
    recordWrite(agentId, absolutePath, trust, options) {
      const work = chain.then(async () => {
        const filePath = ledgerPath(agentId);
        const before = await read(agentId);
        const paths = nextPaths(before, absolutePath, trust, options.append);
        // A clean write that had nothing to clear changes nothing, and a
        // ledger rewritten for no reason would make every ordinary write a
        // file replacement — and a failure, on a host whose workspace root
        // is unwritable, of a write that never needed the ledger at all.
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
          trust: paths[absolutePath] ?? null,
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
