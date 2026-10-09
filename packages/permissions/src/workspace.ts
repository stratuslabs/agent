import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { CommandAnalysis } from './commands.ts';

/**
 * Workspace autonomy, for reads: a command that only reads, and only reads
 * paths inside the agent's own workspace, runs without asking.
 *
 * The built-in safe list can't do this because it judges a string with no
 * idea where it runs: `cat notes.md` and `cat ~/.stratus/credentials.json`
 * are the same shape. Here the shell's working directory and the agent's
 * workspace are known, so every path argument is resolved, symlinks and
 * all, and the command runs only when each one lands inside.
 *
 * This is argument-level policy, not a sandbox. It holds because every
 * command listed here reads only what it's told to (or the working
 * directory), and because the flags that would make one read elsewhere,
 * follow links out, run a program, or write a file aren't on its list. An
 * unknown flag, a token the shell would expand, or a path that won't
 * resolve means the command isn't judged here at all, and it asks.
 */

interface Reader {
  /** Flags that take the next token as their value (`-n 5`, `-e pattern`). */
  valueFlags?: string[];
  /** Flags with no value. Short ones may be bundled (`-rn`). */
  flags: string[];
  /** The first positional is a pattern, not a path, unless a pattern flag was given. */
  pattern?: boolean;
  /** Flags that supply the pattern, so every positional is a path. */
  patternFlags?: string[];
  /** Flags that mean no pattern at all (`rg --files`). */
  noPatternFlags?: string[];
  /** With no path, it reads the working directory (recursively, for some). */
  readsCwd?: boolean | ((flags: Set<string>) => boolean);
  /** A count shorthand like `head -20`. */
  numeric?: boolean;
}

const READERS: Record<string, Reader> = {
  cat: { flags: ['-n', '-b', '-s', '-v', '-e', '-t', '-u', '-A', '-E', '-T', '--number', '--number-nonblank', '--squeeze-blank', '--show-all', '--show-ends', '--show-tabs'] },
  ls: {
    flags: [
      '-l', '-a', '-A', '-h', '-R', '-t', '-r', '-S', '-1', '-d', '-F', '-G', '-i', '-s', '-p', '-C', '-c', '-u', '-U', '-m', '-n', '-o', '-x', '-g', '-k', '-T',
      '--all', '--almost-all', '--human-readable', '--recursive', '--reverse', '--directory', '--classify', '--color', '--no-color', '--inode', '--size',
    ],
    readsCwd: true,
  },
  head: { valueFlags: ['-n', '-c', '--lines', '--bytes'], flags: ['-q', '-v', '--quiet', '--silent', '--verbose'], numeric: true },
  tail: { valueFlags: ['-n', '-c', '--lines', '--bytes'], flags: ['-q', '-v', '-r', '--quiet', '--silent', '--verbose'], numeric: true },
  wc: { flags: ['-l', '-w', '-c', '-m', '-L', '--lines', '--words', '--bytes', '--chars', '--max-line-length'] },
  grep: {
    // `--color` is not a value flag: its argument is optional and only
    // ever attached (`--color=always`), so `grep --color root /etc/passwd`
    // has `root` as its pattern.
    valueFlags: ['-e', '-m', '-A', '-B', '-C', '--regexp', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir'],
    flags: [
      '--color', '--colour',
      '-i', '-v', '-n', '-l', '-L', '-c', '-o', '-q', '-s', '-r', '-w', '-x', '-E', '-F', '-G', '-h', '-H', '-I', '-a', '-b', '-Z', '-z',
      '--ignore-case', '--invert-match', '--line-number', '--files-with-matches', '--files-without-match', '--count', '--only-matching',
      '--quiet', '--silent', '--no-messages', '--recursive', '--word-regexp', '--line-regexp', '--extended-regexp', '--fixed-strings',
      '--basic-regexp', '--no-filename', '--with-filename', '--binary-files', '--text', '--byte-offset', '--null', '--null-data',
    ],
    pattern: true,
    patternFlags: ['-e', '--regexp'],
    // Without -r, grep with no file reads stdin, which is the pipeline rule's
    // business, not this one's.
    readsCwd: (flags) => flags.has('-r') || flags.has('--recursive'),
  },
  rg: {
    valueFlags: [
      '-e', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-M', '--regexp', '--glob', '--iglob', '--type', '--type-not', '--max-count',
      '--after-context', '--before-context', '--context', '--max-columns', '--max-depth', '--max-filesize', '--sort', '--sortr', '--color', '--colors',
    ],
    flags: [
      '-i', '-s', '-S', '-v', '-n', '-N', '-l', '-c', '-o', '-w', '-x', '-F', '-u', '-U', '-P', '-H', '-I', '-0', '-a',
      '--ignore-case', '--case-sensitive', '--smart-case', '--invert-match', '--line-number', '--no-line-number', '--files',
      '--files-with-matches', '--files-without-match', '--count', '--count-matches', '--only-matching', '--word-regexp', '--line-regexp',
      '--fixed-strings', '--hidden', '--no-ignore', '--unrestricted', '--multiline', '--pcre2', '--json', '--no-heading', '--heading',
      '--vimgrep', '--with-filename', '--no-filename', '--null', '--text', '--stats', '--trim', '--no-messages', '--no-config',
      '--no-ignore-parent', '--no-ignore-global', '--no-ignore-dot', '--no-ignore-vcs', '--no-ignore-files', '--no-ignore-exclude',
    ],
    pattern: true,
    patternFlags: ['-e', '--regexp'],
    noPatternFlags: ['--files'],
    readsCwd: true,
  },
};

/**
 * `find`'s expression primaries that only test or print. Everything that
 * runs a program (`-exec`, `-ok`), deletes, writes a file (`-fprint`), or
 * follows links out (`-L`, `-follow`) is missing, so it asks.
 */
const FIND_TESTS_WITH_VALUE = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-maxdepth', '-mindepth',
  '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-perm', '-user', '-group', '-links',
]);
const FIND_TESTS = new Set(['-print', '-print0', '-empty', '-prune', '-not', '!', '-o', '-or', '-a', '-and', '-true', '-false', '-depth', '-xdev', '-readable', '-writable', '-executable']);
/** Primaries whose value is a path, which must be inside too. */
const FIND_PATH_TESTS = new Set(['-newer', '-anewer', '-cnewer', '-samefile']);

const isNumericFlag = (token: string): boolean => /^-\d+$/.test(token);

/** Short flags may be bundled (`-rn`); each letter must be allowed on its own. */
const flagAllowed = (reader: Reader, token: string): boolean => {
  if (reader.flags.includes(token)) {
    return true;
  }
  if (token.startsWith('--')) {
    const [name] = token.split('=');
    return name !== undefined && (reader.flags.includes(name) || (reader.valueFlags ?? []).includes(name));
  }
  if (token.length > 2 && !token.includes('=')) {
    return [...token.slice(1)].every((letter) => reader.flags.includes(`-${letter}`));
  }
  return false;
};

/**
 * The paths a read would touch, or undefined when the command isn't one
 * this rule understands. `.` stands for the working directory.
 */
const readPaths = (base: string, args: string[]): string[] | undefined => {
  if (base === 'find') {
    const paths: string[] = [];
    let index = 0;
    while (index < args.length && !(args[index] as string).startsWith('-') && args[index] !== '!') {
      paths.push(args[index] as string);
      index += 1;
    }
    for (; index < args.length; index += 1) {
      const token = args[index] as string;
      if (FIND_TESTS.has(token)) {
        continue;
      }
      if (FIND_TESTS_WITH_VALUE.has(token) || FIND_PATH_TESTS.has(token)) {
        const value = args[index + 1];
        if (value === undefined) {
          return undefined;
        }
        if (FIND_PATH_TESTS.has(token)) {
          paths.push(value);
        }
        index += 1;
        continue;
      }
      return undefined;
    }
    return paths.length === 0 ? ['.'] : paths;
  }

  const reader = READERS[base];
  if (!reader) {
    return undefined;
  }
  const positionals: string[] = [];
  // Flags after the first operand mean two things: GNU tools read them as
  // flags, BSD ones (and GNU under POSIXLY_CORRECT) as more files. So they
  // must pass as flags and, as files, land inside: `head inside -n
  // /etc/passwd` reads /etc/passwd on a Mac.
  const operandsToo: string[] = [];
  const seen = new Set<string>();
  let patternGiven = false;
  let endOfFlags = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!endOfFlags && token === '--') {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && token.startsWith('-') && token !== '-') {
      if (positionals.length > 0) {
        operandsToo.push(token);
      }
      if (reader.numeric && isNumericFlag(token)) {
        continue;
      }
      if ((reader.valueFlags ?? []).includes(token)) {
        if (args[index + 1] === undefined) {
          return undefined;
        }
        if (positionals.length > 0) {
          operandsToo.push(args[index + 1] as string);
        }
        if ((reader.patternFlags ?? []).includes(token)) {
          patternGiven = true;
        }
        seen.add(token);
        index += 1;
        continue;
      }
      if (!flagAllowed(reader, token)) {
        return undefined;
      }
      const [name] = token.split('=');
      if ((reader.patternFlags ?? []).includes(name ?? '')) {
        patternGiven = true;
      }
      seen.add(name ?? token);
      if (!token.startsWith('--')) {
        for (const letter of token.slice(1)) {
          seen.add(`-${letter}`);
        }
      }
      continue;
    }
    // A lone `-` is a positional like any other: stdin as a file, or, in
    // the pattern position, the pattern. Dropping it would shift a real
    // path into the pattern slot (`grep - /etc/passwd`).
    positionals.push(token);
  }
  // ripgrep reads ignore files above the directory it searches and the
  // user's global ignore file by default: reads outside the workspace,
  // however harmless. It runs here only told not to, by `--no-ignore` (or
  // `-u`), or by both `--no-ignore-parent` and `--no-ignore-global`.
  if (base === 'rg' && !seen.has('--no-ignore') && !seen.has('-u') && !seen.has('--unrestricted')
    && !(seen.has('--no-ignore-parent') && seen.has('--no-ignore-global'))) {
    return undefined;
  }
  const noPattern = (reader.noPatternFlags ?? []).some((flag) => seen.has(flag));
  const paths = [...(reader.pattern && !patternGiven && !noPattern ? positionals.slice(1) : positionals), ...operandsToo];
  if (reader.pattern && !patternGiven && !noPattern && positionals.length === 0) {
    return undefined;
  }
  if (paths.length === 0) {
    const readsCwd = typeof reader.readsCwd === 'function' ? reader.readsCwd(seen) : reader.readsCwd === true;
    return readsCwd ? ['.'] : [];
  }
  return paths;
};

/** Whether `child` is `parent` or inside it, both already resolved. */
const within = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Where a path really is: the nearest ancestor that exists, resolved through
 * its symlinks, with whatever doesn't exist yet appended. A path that
 * doesn't exist reads nothing, but `ls missing/../../..` still has to be
 * judged by where it points.
 */
const resolveReal = async (target: string): Promise<string | undefined> => {
  let existing = target;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...missing.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        return undefined;
      }
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
};

/**
 * Where `target` lands when the kernel walks it from `base`: each component
 * in turn, symlinks followed as they are reached. Normalizing first, the
 * way `path.resolve` does, would cancel `link/..` lexically, while the
 * kernel follows `link` and then takes the parent of wherever it pointed.
 */
const walk = async (base: string, target: string): Promise<string | undefined> => {
  let current = path.isAbsolute(target) ? await resolveReal(path.parse(target).root) : await resolveReal(base);
  if (current === undefined) {
    return undefined;
  }
  for (const segment of target.split(path.sep)) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    const next: string = path.join(current, segment);
    // Missing from here on: nothing below it exists to follow, so the rest
    // is lexical, and a read of it reads nothing.
    current = await realpath(next).catch(() => next);
  }
  return current;
};

/**
 * Whether one command (not a pipeline) only reads, and only inside the
 * workspace. `cwd` is where the shell will run it.
 */
export const readsInsideWorkspace = async (
  analysis: CommandAnalysis,
  cwd: string,
  workspace: string,
): Promise<boolean> => {
  if (analysis.disqualifiedBy || analysis.base === undefined || analysis.pipeline) {
    return false;
  }
  // A glob, `~`, `$`, or brace becomes paths this parser never saw. A
  // workspace can hold a symlink a glob would expand to, and `cat *` would
  // follow it out.
  if (analysis.expands?.some((expands) => expands)) {
    return false;
  }
  // Inside double quotes `$` and backticks still expand, and the tokenizer
  // marks only what expands unquoted: `cat "$HOME/.ssh/id_rsa"` would read
  // as a literal path under the workspace. Any `$`, backtick, or backslash,
  // however quoted, means the shell may read something this parser didn't.
  if (analysis.tokens.some((token) => /[$`\\]/.test(token))) {
    return false;
  }
  const paths = readPaths(analysis.base, analysis.tokens.slice(1));
  if (paths === undefined) {
    return false;
  }
  const root = await resolveReal(workspace);
  const here = await resolveReal(cwd);
  if (root === undefined || here === undefined || !within(root, here)) {
    return false;
  }
  for (const target of paths) {
    const resolved = await walk(here, target);
    if (resolved === undefined || !within(root, resolved)) {
      return false;
    }
  }
  return true;
};
