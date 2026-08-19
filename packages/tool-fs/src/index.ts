import { constants } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject, JsonValue, Plugin, Session, Tool } from '@stratusagent/core';
import { resolvePluginAgentConfig } from '@stratusagent/plugins';

import {
  isRealDirectory,
  openContained,
  resolveWithinRoots,
  type ResolvedPath,
} from './paths.ts';

export {
  canonicalRoots,
  expandHome,
  openContained,
  PathOutsideRootError,
  resolveWithinRoots,
} from './paths.ts';

/** Defaults chosen so a tool result is something a model can actually read. */
const DEFAULT_MAX_BYTES = 64_000;
const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MAX_SEARCH_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_ENTRIES = 500;

export interface FsPluginConfig extends JsonObject {
  /** Directories this agent may reach. Nothing outside them is readable. */
  roots?: string[];
  /** Cap on a single read, before truncation. */
  maxBytes?: number;
  /** Cap on `fs.search` matches. */
  maxMatches?: number;
  /** Cap on `fs.list` entries. */
  maxEntries?: number;
}

const asStrings = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const asNumber = (value: JsonValue | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const requireString = (input: JsonObject, key: string): string => {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required and must be a string.`);
  }
  return value;
};

/**
 * What this agent may reach — resolved **per call**, from the session.
 *
 * Not a convenience: two agents with different roots is the whole point of
 * the per-agent block, and a plugin that read its roots once at setup would
 * hand every agent whichever set happened to be resolved first. That is one
 * agent reading another's files, and it is the failure this signature
 * exists to make impossible to write.
 */
const settingsFor = (config: JsonObject, session: Session) => {
  const resolved = resolvePluginAgentConfig(config, session.agent.id);
  return {
    roots: asStrings(resolved.roots),
    maxBytes: asNumber(resolved.maxBytes, DEFAULT_MAX_BYTES),
    maxMatches: asNumber(resolved.maxMatches, DEFAULT_MAX_MATCHES),
    maxEntries: asNumber(resolved.maxEntries, DEFAULT_MAX_ENTRIES),
    home: typeof resolved.home === 'string' ? resolved.home : os.homedir(),
  };
};

/**
 * Whether a buffer is text, decided the way `grep` decides it: a NUL byte
 * means binary. Returning a megabyte of mojibake to a model helps nobody,
 * and returning "this is binary" is an answer it can act on.
 */
const looksBinary = (buffer: Buffer): boolean => buffer.includes(0);

const relativeTo = (root: string, target: string): string => path.relative(root, target) || '.';

const readContained = async (
  resolved: ResolvedPath,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean; bytes: number; size: number; binary: boolean }> => {
  if (resolved.kind === 'directory') {
    throw new Error(`${resolved.path} is a directory; use fs.list.`);
  }
  if (resolved.kind === 'other') {
    // A FIFO, a socket, a device. Opening one does not fail — it *blocks*,
    // and a tool call that never returns is worse than one that refuses.
    throw new Error(`${resolved.path} is not a regular file.`);
  }
  // `O_NONBLOCK` alongside the check above, and not instead of it: the check
  // gives a refusal an agent can read, and this makes the failure mode of
  // *missing* one a returned error rather than a turn that never ends. It
  // has no effect on a regular file.
  const handle = await openContained(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (info.isDirectory()) {
      throw new Error(`${resolved.path} is a directory; use fs.list.`);
    }
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (looksBinary(slice)) {
      return { content: '', truncated: false, bytes: bytesRead, size: info.size, binary: true };
    }
    return {
      content: slice.toString('utf8'),
      truncated: info.size > bytesRead,
      bytes: bytesRead,
      size: info.size,
      binary: false,
    };
  } finally {
    await handle.close();
  }
};

const createReadTool = (config: JsonObject): Tool => ({
  name: 'fs.read',
  description: 'Read a UTF-8 text file inside one of this agent’s roots.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute, or relative to the agent’s first root.' },
      maxBytes: { type: 'number', description: 'Stop after this many bytes.' },
    },
    required: ['path'],
  },
  async execute(input, session) {
    const settings = settingsFor(config, session);
    const requested = requireString(input, 'path');
    const resolved = await resolveWithinRoots(settings.roots, requested, { home: settings.home });
    const maxBytes = asNumber(input.maxBytes, settings.maxBytes);
    const result = await readContained(resolved, maxBytes);
    return {
      path: relativeTo(resolved.root, resolved.path),
      absolutePath: resolved.path,
      ...(result.binary
        ? { binary: true, bytes: result.size }
        : {
            content: result.content,
            bytes: result.bytes,
            size: result.size,
            // Said outright rather than left for the model to notice: a
            // silently clipped file reads as a complete one, and a summary
            // written from half a document is confidently wrong.
            truncated: result.truncated,
          }),
    };
  },
});

const entryKind = (entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): string => {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
};

const createListTool = (config: JsonObject): Tool => ({
  name: 'fs.list',
  description: 'List a directory inside one of this agent’s roots.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Defaults to the agent’s first root.' },
    },
  },
  async execute(input, session) {
    const settings = settingsFor(config, session);
    const requested = typeof input.path === 'string' && input.path.length > 0 ? input.path : '.';
    const resolved = await resolveWithinRoots(settings.roots, requested, { home: settings.home });
    if (!(await isRealDirectory(resolved.path))) {
      throw new Error(`${requested} is not a directory; use fs.read.`);
    }

    const entries = await readdir(resolved.path, { withFileTypes: true });
    const listed = entries.slice(0, settings.maxEntries);
    const detailed = await Promise.all(listed.map(async (entry) => {
      const full = path.join(resolved.path, entry.name);
      let size: number | undefined;
      if (entry.isFile()) {
        try {
          size = (await stat(full)).size;
        } catch {
          size = undefined;
        }
      }
      return {
        name: entry.name,
        // Symlinks are reported as symlinks and never followed here: a
        // listing that resolved them would describe files outside the root
        // as if they were inside it.
        type: entryKind(entry),
        ...(size === undefined ? {} : { size }),
      };
    }));

    return {
      path: relativeTo(resolved.root, resolved.path),
      entries: detailed,
      truncated: entries.length > listed.length,
    };
  },
});

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

const createSearchTool = (config: JsonObject): Tool => ({
  name: 'fs.search',
  description: 'Search file contents for literal text under one of this agent’s roots.',
  risk: 'safe',
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
  async execute(input, session) {
    const settings = settingsFor(config, session);
    const query = requireString(input, 'query');
    const requested = typeof input.path === 'string' && input.path.length > 0 ? input.path : '.';
    const resolved = await resolveWithinRoots(settings.roots, requested, { home: settings.home });
    const limit = asNumber(input.maxMatches, settings.maxMatches);
    const pattern = matcherFor(query, {
      caseSensitive: input.caseSensitive === true,
      wholeWord: input.wholeWord === true,
    });

    const matches: SearchMatch[] = [];
    let truncated = false;
    // A file is searched as itself. Falling back to its parent would answer
    // a question nobody asked — `{ path: 'notes/today.md' }` coming back
    // with hits from every other note is a wrong answer, not a generous one.
    const files = (await isRealDirectory(resolved.path))
      ? walkFiles(resolved.path)
      : (async function* single() {
          yield resolved.path;
        })();

    for await (const file of files) {
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      let contents: Buffer;
      try {
        const info = await stat(file);
        if (info.size > DEFAULT_MAX_SEARCH_FILE_BYTES) {
          continue;
        }
        contents = await readFile(file);
      } catch {
        continue;
      }
      if (looksBinary(contents)) {
        continue;
      }
      const lines = contents.toString('utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (!pattern.test(line)) {
          continue;
        }
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({
          path: relativeTo(resolved.root, file),
          line: index + 1,
          text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
        });
      }
    }

    return { query, matches, truncated };
  },
});

const createWriteTool = (config: JsonObject): Tool => ({
  name: 'fs.write',
  description: 'Write a UTF-8 text file inside one of this agent’s roots.',
  // Gated, not safe: it acts on the world outside Stratus and outlives the
  // turn. Reading inside a root a human chose is the thing that does not.
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      append: { type: 'boolean' },
    },
    required: ['path', 'content'],
  },
  async execute(input, session) {
    const settings = settingsFor(config, session);
    const requested = requireString(input, 'path');
    const content = typeof input.content === 'string' ? input.content : '';
    const resolved = await resolveWithinRoots(settings.roots, requested, {
      home: settings.home,
      allowMissing: true,
    });

    if (!resolved.exists) {
      // The parent is created only after the resolution above put it inside
      // a root — `root/link/notes/x.md` through a symlinked `link` never
      // gets this far, so nothing is created outside the boundary either.
      await mkdir(path.dirname(resolved.path), { recursive: true });
    } else if (resolved.kind !== 'file') {
      // Same reason as the read path: writing into a directory is a mistake
      // worth naming, and writing into a fifo or a device blocks forever.
      throw new Error(
        resolved.kind === 'directory'
          ? `${resolved.path} is a directory.`
          : `${resolved.path} is not a regular file.`,
      );
    }

    const flags = input.append === true
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
      : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
    // O_NOFOLLOW is applied by openContained: a symlink sitting at the
    // destination must fail rather than write through to its target, which
    // is the write half of the escape a read-only check would miss.
    const handle = await openContained(resolved, flags | (constants.O_NONBLOCK ?? 0), 0o644);
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }

    return {
      path: relativeTo(resolved.root, resolved.path),
      absolutePath: resolved.path,
      bytes: Buffer.byteLength(content, 'utf8'),
      appended: input.append === true,
    };
  },
});

/**
 * The filesystem toolset.
 *
 * Reads are `safe` and writes are `gated`, which is the risk model applied
 * rather than a compromise: reading inside a directory a human chose is
 * work an agent does on its own, and writing where other people read is the
 * thing worth a person's attention. The roots are what make the first half
 * true, so they are an access boundary and not a preference — resolved from
 * `session.agent.id` on every call.
 */
export const createFsPlugin = (config: JsonObject = {}): Plugin => ({
  name: '@stratusagent/tool-fs',
  setup(context) {
    context.tools.register(createReadTool(config));
    context.tools.register(createListTool(config));
    context.tools.register(createSearchTool(config));
    context.tools.register(createWriteTool(config));
  },
});

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = createFsPlugin;
