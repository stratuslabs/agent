/*
 * `fs.search`: literal text in the files under a directory inside the
 * agent's roots, read line by line with long lines and large files bounded.
 * Files it could not search are skipped and listed in the result.
 */
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

import type { JsonObject, Tool } from '@stratusagent/core';
import type {
  FileIdentity,
  LedgerGuard,
  ProtectedPathGuard,
  TaintedWriteLedger,
} from '@stratusagent/plugins';

import { openContained, type ResolvedPath, resolveWithinRoots } from './paths.ts';
import {
  DEFAULT_MAX_SEARCH_FILE_BYTES,
  looksBinary,
  narrowed,
  O_NOFOLLOW_FLAG,
  refuseProtected,
  relativeTo,
  requireString,
  settingsFor,
} from './shared.ts';
import { ledgerContentTrustAmong, lowest, recordedTrustAmong, type ShownFile } from './trust.ts';

interface SearchMatch extends JsonObject {
  path: string;
  line: number;
  text: string;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The matcher for one search.
 *
 * Built from an **escaped literal**, always. `fs.search` is `safe` — it
 * runs unattended, on the process's only thread, with a pattern a model
 * wrote — and V8's regex engine backtracks: `(a+)+$` against a long line of
 * `a`s does not return in any time worth waiting for, and while it runs
 * every session in the daemon is stopped. There is no timeout to give it
 * and no way to interrupt it on this thread.
 *
 * So the expressive form is gone rather than bounded. `wholeWord` covers
 * the case it was mostly wanted for; anything genuinely regex-shaped is a
 * `shell.run` away, where a human approves the command and the executor
 * can kill it.
 */
const matcherFor = (query: string, options: { caseSensitive?: boolean; wholeWord?: boolean }): RegExp => {
  const literal = escapeRegExp(query);
  return new RegExp(
    options.wholeWord ? `\\b${literal}\\b` : literal,
    options.caseSensitive ? '' : 'i',
  );
};

/**
 * A text file a line at a time, or `undefined` once when it turns out to be
 * binary — decided on every chunk as it streams, since a file that starts
 * as text and turns binary later was read whole and judged whole before
 * it was streamed. Streamed in chunks so a file named outright can be any
 * size, and so can a line: a minified file or a base64 log is one line for
 * megabytes, and a reader that accumulates a whole line before yielding it
 * holds the whole file after all. A line past `MAX_LINE_CHARS` is yielded
 * as its first `MAX_LINE_CHARS` characters and the rest is discarded to the
 * next newline; the line says so through `clipped` — said there rather
 * than inferred from its length, because a line of exactly
 * `MAX_LINE_CHARS` was searched whole. Characters are Unicode code points,
 * not UTF-16 code units: counted by `length`, a line of half a million
 * emoji would have been clipped at a "million characters" it never
 * reached, and the cut could land between the halves of a pair.
 *
 * Opened through `openContained`, like `fs.read`: the containment check
 * captured the file's identity, and a name repointed between that check
 * and this open is refused here rather than read. The size comes from the
 * open descriptor for the same reason — a `stat` of the name afterwards is
 * fresh evidence about whatever the name points at by then, which after a
 * log rotation is a different file or none.
 */
const MAX_LINE_CHARS = 1_000_000;

interface LineRead {
  text: string;
  clipped: boolean;
  /**
   * The code point that came right after a clip, kept so a match ending at
   * the clip can be told from one ending at a real word boundary. Empty
   * when the line was not clipped.
   */
  next: string;
}

interface OpenedLines {
  /** The size of the file that was opened, in bytes. */
  size: number;
  lines: AsyncGenerator<LineRead | undefined>;
  /**
   * Set when the file reported no size and the read reached the cap that
   * stands in for one — so the caller can say the search stopped there.
   */
  capped: boolean;
}

/**
 * How much of a file that reports no size is read. A virtual file
 * (`/proc/version`, a sysfs attribute) has content its size does not admit
 * to, so it cannot be bounded by its size; a regular file that was empty
 * when opened and is being appended to cannot be bounded by it either,
 * and an unbounded read would run for as long as the writer stays ahead.
 * The walk limit is the bound the tool already lives with.
 */
const MAX_UNSIZED_FILE_BYTES = DEFAULT_MAX_SEARCH_FILE_BYTES;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Code points, not code units — only ever asked of text that might be over the limit. */
const codePointLength = (text: string): number => {
  let pairs = 0;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1))) {
      pairs += 1;
      index += 1;
    }
  }
  return text.length - pairs;
};

/** The first `count` code points of `text`, never ending inside a pair. */
const firstCodePoints = (text: string, count: number): string => {
  let units = 0;
  for (let seen = 0; seen < count && units < text.length; seen += 1) {
    units += isHighSurrogate(text.charCodeAt(units)) && units + 1 < text.length && isLowSurrogate(text.charCodeAt(units + 1)) ? 2 : 1;
  }
  return text.slice(0, units);
};

/**
 * A line clipped to the limit when it is over it, in code points. `length`
 * is a ceiling on code points, so a line within it in code units is within
 * it and is not counted.
 */
const bounded = (text: string): LineRead => {
  if (text.length <= MAX_LINE_CHARS || codePointLength(text) <= MAX_LINE_CHARS) {
    return { text, clipped: false, next: '' };
  }
  const kept = firstCodePoints(text, MAX_LINE_CHARS);
  return { text: kept, clipped: true, next: firstCodePoints(text.slice(kept.length), 1) };
};

/**
 * Whether the query occurs inside the part of this line that was searched.
 *
 * A clipped line ends where the tool stopped reading, not where the file's
 * line ends, and `\b` at that artificial end would call a word cut in half
 * a whole word. The code point that came next is kept for exactly this: the
 * match runs against it too, and counts only if it ends before it.
 */
const matchesWithin = (pattern: RegExp, line: LineRead): boolean => {
  if (!line.clipped || line.next.length === 0) {
    return pattern.test(line.text);
  }
  const found = pattern.exec(line.text + line.next);
  return found !== null && found.index + found[0].length <= line.text.length;
};

const openLines = async (resolved: ResolvedPath): Promise<OpenedLines> => {
  const handle = await openContained(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const { size } = await handle.stat();
    const capped = { capped: false };
    return { size, lines: linesOf(handle, size, capped), get capped() { return capped.capped; } };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

/** Owns `handle`: closes it when the lines run out, or when the caller stops early. */
const linesOf = async function* (
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  opened: { capped: boolean },
): AsyncGenerator<LineRead | undefined> {
  try {
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let discarding = false;
    let discardedNext = '';
    // Bounded to the size the file had when it was opened: a log being
    // appended to would otherwise be read for as long as its writer stays
    // ahead, and the result's `bytes` would name a size the search had
    // long passed. One call searches one finite snapshot. A file that
    // reports no size is bounded by `MAX_UNSIZED_FILE_BYTES` instead (see
    // there); a file that is really empty ends its stream at once either way.
    // The unsized bound reads one byte past the cap on purpose: that byte
    // arriving is the only proof there was more, so a file of exactly the
    // cap is reported as searched whole rather than as clipped.
    const end = size > 0 ? size - 1 : MAX_UNSIZED_FILE_BYTES;
    let read = 0;
    for await (const raw of handle.createReadStream({ start: 0, end, highWaterMark: 64 * 1024 })) {
      // Whatever came past the cap is the probe and nothing more: it says
      // there was more to read, and is not itself searched, decoded, or
      // weighed in the binary verdict — the file's first
      // `MAX_UNSIZED_FILE_BYTES` bytes are what this call reports on.
      const over = size === 0 ? Math.max(0, read + (raw as Buffer).length - MAX_UNSIZED_FILE_BYTES) : 0;
      read += (raw as Buffer).length;
      if (over > 0) {
        opened.capped = true;
      }
      const chunk = over > 0 ? (raw as Buffer).subarray(0, (raw as Buffer).length - over) : (raw as Buffer);
      if (chunk.length === 0) {
        break;
      }
      if (looksBinary(chunk)) {
        yield undefined;
        return;
      }
      const text = decoder.write(chunk);
      let from = 0;
      for (;;) {
        const newline = text.indexOf('\n', from);
        if (newline === -1) {
          if (!discarding) {
            carry += text.slice(from);
            // Decoded chunks end on whole code points (the decoder holds a
            // partial sequence back), so a pair is never split across them.
            const clipped = bounded(carry);
            if (clipped.clipped) {
              carry = clipped.text;
              discarding = true;
              discardedNext = clipped.next;
            }
          }
          break;
        }
        yield discarding
          ? { text: carry, clipped: true, next: discardedNext }
          : bounded(carry + text.slice(from, newline));
        carry = '';
        discarding = false;
        discardedNext = '';
        from = newline + 1;
      }
    }
    const tail: LineRead = discarding
      ? { text: carry, clipped: true, next: discardedNext }
      : bounded(carry + decoder.end());
    if (tail.text.length > 0) {
      yield tail;
    }
  } finally {
    await handle.close();
  }
};

/** How many skipped files a result names outright; the rest are a count. */
const MAX_SKIPPED_REPORTED = 50;

const walkFiles = async function* (directory: string, depth = 0): AsyncGenerator<string> {
  if (depth > 12) {
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Never through a symlink: following one would walk out of the root,
    // and the containment check only ran on the directory we were given.
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      yield* walkFiles(full, depth + 1);
      continue;
    }
    if (entry.isFile()) {
      yield full;
    }
  }
};

export const createSearchTool = (
  config: JsonObject,
  ledger: TaintedWriteLedger,
  isLedger: () => Promise<LedgerGuard>,
  isProtected: () => Promise<ProtectedPathGuard>,
): Tool => ({
  name: 'fs.search',
  description: 'Search file contents for literal text under one of this agent’s roots.',
  risk: 'safe',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Literal text to find. Not a regular expression.' },
      path: { type: 'string', description: 'Where to search. Defaults to the agent’s first root.' },
      wholeWord: { type: 'boolean', description: 'Match only whole words.' },
      caseSensitive: { type: 'boolean' },
      maxMatches: { type: 'number' },
    },
    required: ['query'],
  },
  async execute(input, session, context) {
    const settings = settingsFor(config, session);
    const query = requireString(input, 'query');
    const requested = typeof input.path === 'string' && input.path.length > 0 ? input.path : '.';
    const resolved = await resolveWithinRoots(settings.roots, requested, { home: settings.home });
    await refuseProtected(isProtected, resolved, requested);
    // Built once per call: the walk below asks it about every file.
    const protectedBy = await isProtected();
    const limit = narrowed(input.maxMatches, settings.maxMatches);
    const pattern = matcherFor(query, {
      caseSensitive: input.caseSensitive === true,
      wholeWord: input.wholeWord === true,
    });

    const matches: SearchMatch[] = [];
    // A match is a line of the file's content in the result, and a skipped
    // file is named in it, so either kind of file the ledger knows taints
    // the call the way `fs.read` of it would. A file that produced no match
    // and was not skipped puts nothing in front of the model.
    // Keyed by path, holding the inode each was read at — see `LedgerGuard`.
    const namedFiles = new Map<string, ShownFile>();
    const ledgerBefore = await ledger.snapshot(session.agent.id);
    // What the walk looked past, said outright. A file over the size
    // limit used to vanish from the result: a search of a directory holding
    // one 6.7 MB log came back with no matches and no hint that the log
    // was never opened, and a summary written from that is confidently
    // wrong in the way a silently clipped read is.
    const skipped: Array<{ path: string; bytes: number; reason: string }> = [];
    // Bounded like the matches: a directory of large files would otherwise
    // put one record per file into a result the search limit was meant
    // to keep small. Past the cap, they are a count.
    let skippedTotal = 0;
    const skip = (entry: { path: string; bytes: number; reason: string }, identity?: FileIdentity): void => {
      skippedTotal += 1;
      if (skipped.length < MAX_SKIPPED_REPORTED) {
        skipped.push(entry);
        // `entry.path` is relative to the root the search resolved in.
        namedFiles.set(path.join(resolved.root, entry.path), { identity });
      }
    };
    const report = async (): Promise<JsonObject> => {
      const recorded = lowest(
        await recordedTrustAmong(ledger, session.agent.id, namedFiles.keys(), resolved.root, ledgerBefore),
        await ledgerContentTrustAmong(isLedger, namedFiles),
      );
      if (recorded !== undefined) {
        context?.markTrust?.(recorded);
      }
      return {
        query,
        matches,
        truncated,
        ...(skippedTotal > 0 ? { skipped, skippedTotal } : {}),
      };
    };
    let truncated = false;
    // A file is searched as itself. Falling back to its parent would answer
    // a question nobody asked — `{ path: 'notes/today.md' }` coming back
    // with hits from every other note is a wrong answer, not a generous one.
    if (resolved.kind === 'other') {
      // The same trap `fs.read` has: `readFile` on a fifo with no writer
      // does not fail, it waits — and `fs.search` is `safe`, so it waits
      // with nobody watching. The walk below cannot hit this (a directory
      // entry is only yielded when it is a regular file); a path handed to
      // us directly can.
      throw new Error(`${resolved.path} is not a regular file.`);
    }
    const record = (file: string, index: number, line: string, shown: ShownFile): boolean => {
      if (matches.length >= limit) {
        truncated = true;
        return false;
      }
      matches.push({
        path: relativeTo(resolved.root, file),
        line: index + 1,
        text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
      });
      namedFiles.set(file, shown);
      return true;
    };

    if (resolved.kind === 'file') {
      // A file named outright is searched whatever its size — the caller
      // asked about this file, not about a limit meant for a walk — and
      // streamed a line at a time, so the size limit's reason (a directory
      // full of large files read whole) does not apply.
      let index = 0;
      let clipped = false;
      const opened = await openLines(resolved);
      const { size, lines } = opened;
      const before = matches.length;
      const truncatedBefore = truncated;
      // A file named outright is streamed, not held — except the ledger,
      // whose label is judged on the bytes shown (see
      // `ledgerContentTrustAmong`), so its lines are kept as they pass.
      // Known before the stream starts, from the resolution's inode.
      const isLedgerFile = await (await isLedger())(resolved.path, resolved.identity);
      const kept: string[] = [];
      const shown: ShownFile = { identity: resolved.identity };
      // Past the match cap the file is still read to its end, no longer
      // matched: the binary verdict is decided on every chunk, and a NUL
      // after the cap would otherwise go unseen, leaving matches from a
      // file that is not text standing as results.
      let capped = false;
      for await (const line of lines) {
        if (line === undefined) {
          // Binary after all: what matched in the text before the first
          // NUL is not a search result of a text file, because this is
          // not one.
          matches.splice(before);
          // The skip that follows names it again, as a binary file.
          namedFiles.delete(resolved.path);
          truncated = truncatedBefore;
          clipped = false;
          skip({ path: relativeTo(resolved.root, resolved.path), bytes: size, reason: 'binary' }, resolved.identity);
          break;
        }
        clipped ||= line.clipped;
        if (isLedgerFile) {
          kept.push(line.text);
        }
        if (!capped && matchesWithin(pattern, line) && !record(resolved.path, index, line.text, shown)) {
          capped = true;
        }
        index += 1;
      }
      if (isLedgerFile) {
        shown.raw = kept.join('\n');
        shown.truncated = clipped || opened.capped;
      }
      if (clipped) {
        skip({
          path: relativeTo(resolved.root, resolved.path),
          bytes: size,
          reason: `a line longer than ${MAX_LINE_CHARS / 1_000_000} million characters was searched in its first ${MAX_LINE_CHARS / 1_000_000} million only`,
        }, resolved.identity);
      }
      if (opened.capped) {
        skip({
          path: relativeTo(resolved.root, resolved.path),
          bytes: size,
          reason: `reports no size, and was searched in its first ${MAX_UNSIZED_FILE_BYTES / 1_000_000} MB only`,
        }, resolved.identity);
      }
      return report();
    }

    for await (const file of walkFiles(resolved.path)) {
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      // Size, identity, and bytes from one descriptor, so the inode the
      // ledger guard judges is the inode whose lines the result shows.
      let contents: Buffer;
      let identity: FileIdentity;
      try {
        const handle = await open(file, constants.O_RDONLY | O_NOFOLLOW_FLAG | (constants.O_NONBLOCK ?? 0));
        try {
          const info = await handle.stat();
          identity = { dev: info.dev, ino: info.ino };
          // A walk from a broad root passes through the protected home on
          // its way to the workspaces inside it. Named in the result like
          // any other skip, so an empty search says why, but never read.
          if ((await protectedBy(file, identity)) !== undefined) {
            skip({ path: relativeTo(resolved.root, file), bytes: info.size, reason: 'kept from every agent by Stratus' }, identity);
            continue;
          }
          if (info.size > DEFAULT_MAX_SEARCH_FILE_BYTES) {
            skip({
              path: relativeTo(resolved.root, file),
              bytes: info.size,
              reason: `over the ${DEFAULT_MAX_SEARCH_FILE_BYTES / 1_000_000} MB walk limit — search it by name to read it whole`,
            }, identity);
            continue;
          }
          contents = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch {
        continue;
      }
      if (looksBinary(contents)) {
        continue;
      }
      const text = contents.toString('utf8');
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (pattern.test(line) && !record(file, index, line, { identity, raw: text })) {
          break;
        }
      }
    }

    return report();
  },
});
