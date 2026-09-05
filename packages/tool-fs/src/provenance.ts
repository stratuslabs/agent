import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
   * Record a write. A truncating write from a clean session (`user` or
   * `agent`) clears the path: the bytes there are now that session's. An
   * append keeps whatever label was recorded, since the tainted bytes are
   * still in the file, lowered further if the appending session is lower.
   */
  recordWrite(agentId: string, absolutePath: string, trust: TrustLevel, options: { append: boolean }): Promise<void>;
}

/** The ledger's filename inside an agent's workspace. Exported so `fs.write` can refuse to write it. */
export const LEDGER_FILENAME = 'fs-provenance.json';

const LEDGER_VERSION = 1;

interface LedgerFile {
  version: number;
  paths: Record<string, TrustLevel>;
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
    async recordWrite(agentId, absolutePath, trust, options) {
      byAgent.set(agentId, nextPaths(byAgent.get(agentId) ?? {}, absolutePath, trust, options.append));
    },
  };
};

const parseLedger = (raw: string, filePath: string): Record<string, TrustLevel> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The filesystem provenance ledger is not valid JSON: ${filePath}. Delete it to start over; the cost is that files written by earlier tainted sessions read as the agent's own.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const file = parsed as Partial<LedgerFile>;
  if (typeof file.paths !== 'object' || file.paths === null || Array.isArray(file.paths)) {
    return {};
  }
  const paths: Record<string, TrustLevel> = {};
  for (const [recordedPath, trust] of Object.entries(file.paths)) {
    if (isTrustLevel(trust) && tainted(trust)) {
      paths[recordedPath] = trust;
    }
  }
  return paths;
};

/**
 * The durable ledger, one JSON file per agent at
 * `<workspaceRoot>/<agentId>/fs-provenance.json`, owner-only, replaced
 * atomically: a reader sees the old ledger or the new one, never a
 * truncated file.
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
        const temporary = `${filePath}.${process.pid}.tmp`;
        const body: LedgerFile = { version: LEDGER_VERSION, paths };
        await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, filePath);
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
 */
export const isLedgerPath = (workspaceRoot: string | undefined, absolutePath: string): boolean => {
  if (workspaceRoot === undefined) {
    return false;
  }
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(path.sep);
  return segments.length === 2 && segments[1] === LEDGER_FILENAME;
};
