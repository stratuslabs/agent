/*
 * The trust label a result carries. A result that names files is marked
 * with the lowest label the ledger recorded for them and for the directories
 * above them, and one that shows the ledger's own contents is marked by what
 * those contents hold.
 */
import path from 'node:path';

import { leastTrusted, type TrustLevel } from '@stratusagent/core';
import {
  type FileIdentity,
  ledgerContentTrust,
  type LedgerGuard,
  ledgerTrustOfContent,
  type TaintedWriteLedger,
} from '@stratusagent/plugins';

/**
 * The lowest recorded label among `absolutePaths`, or undefined when the
 * ledger knows none of them. A result that names files — a listing, a
 * search's matches and skips — is marked with it: a filename is text the
 * writing session chose, and a tainted session may have chosen it from a
 * page, so even a result that shows no contents carries the label.
 */
/**
 * `absolutePath` and every directory between it and `root`, exclusive of the
 * root: a result that shows `dir/file` shows the directory's name too, and
 * the directory may be what a tainted session created.
 */
export const withAncestors = (absolutePath: string, root: string): string[] => {
  const paths = [absolutePath];
  for (let parent = path.dirname(absolutePath); parent !== root && parent !== path.dirname(parent) && parent.startsWith(root); parent = path.dirname(parent)) {
    paths.push(parent);
  }
  return paths;
};

export const recordedTrustAmong = async (
  ledger: TaintedWriteLedger,
  agentId: string,
  absolutePaths: Iterable<string>,
  /** The root the result's paths are shown relative to; ancestors below it are named by the result. */
  root: string,
  /**
   * The ledger as it stood before the files were read. A listing or a
   * search cannot hold every path it touches under a lock, so it reads
   * the ledger on both sides of the walk and honours whichever is lower,
   * so a record added by a tainted write mid-walk — recorded before its
   * bytes land — is in the second read. Records never clear, so there is
   * no third case.
   */
  before: Record<string, TrustLevel>,
): Promise<TrustLevel | undefined> => {
  const after = await ledger.snapshot(agentId);
  const labels: TrustLevel[] = [];
  for (const absolutePath of absolutePaths) {
    for (const named of withAncestors(absolutePath, root)) {
      for (const label of [before[named], after[named]]) {
        if (label !== undefined) {
          labels.push(label);
        }
      }
    }
  }
  return labels.length > 0 ? leastTrusted(...labels) : undefined;
};

/**
 * The ledger is the one file under a root whose contents are tainted
 * sessions' text by construction — the paths they chose, one per record —
 * and whose own path has no record. A result that shows what is in it
 * (a read, a search that matched a line) is labelled by what it holds. A
 * listing that names it is not: the filename is fixed, and nothing in it
 * was anyone's choice.
 */
/** What a result showed of one file: the inode it was read at, and the bytes, when the caller still holds them. */
export interface ShownFile {
  identity?: FileIdentity | undefined;
  /** The bytes the model was shown, when the whole file was read as text. */
  raw?: string | undefined;
  /** True when `raw` is a prefix of the file, not all of it. */
  truncated?: boolean | undefined;
}

export const ledgerContentTrustAmong = async (
  isLedger: () => Promise<LedgerGuard>,
  named: Iterable<readonly [string, ShownFile]>,
): Promise<TrustLevel | undefined> => {
  const guard = await isLedger();
  const labels: TrustLevel[] = [];
  for (const [absolutePath, shown] of named) {
    if (!(await guard(absolutePath, shown.identity))) {
      continue;
    }
    // Judged on the bytes the model saw whenever the caller still has
    // them, never on a fresh read: a peer rewriting the ledger in place
    // after the read leaves the inode alone and the bytes changed. A
    // prefix of a ledger is at most `unknown` — the records it cut off
    // may sit lower than any it kept.
    let label: TrustLevel | undefined;
    if (shown.raw === undefined) {
      label = await ledgerContentTrust(absolutePath, shown.identity);
    } else if (!shown.truncated) {
      label = ledgerTrustOfContent(shown.raw);
    } else {
      label = leastTrusted(
        'unknown',
        ledgerTrustOfContent(shown.raw) ?? 'unknown',
        (await ledgerContentTrust(absolutePath, shown.identity)) ?? 'unknown',
      );
    }
    if (label !== undefined) {
      labels.push(label);
    }
  }
  return labels.length > 0 ? leastTrusted(...labels) : undefined;
};

export const lowest = (...labels: Array<TrustLevel | undefined>): TrustLevel | undefined => {
  const defined = labels.filter((label): label is TrustLevel => label !== undefined);
  return defined.length > 0 ? leastTrusted(...defined) : undefined;
};
