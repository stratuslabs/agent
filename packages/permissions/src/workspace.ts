import { readFile, realpath } from 'node:fs/promises';
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
      // After an operand, `--` may itself be a file to a tool that stopped
      // reading options there (BSD, or POSIXLY_CORRECT).
      if (positionals.length > 0) {
        operandsToo.push(token);
      }
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
  // ripgrep reads ignore files it was never pointed at: above the directory
  // it searches, the user's global ignore, and a linked worktree's
  // `.git/info/exclude` in a git directory that can be anywhere. Only
  // `--no-ignore` (or `-u`) turns all of them off at once.
  if (base === 'rg' && !seen.has('--no-ignore') && !seen.has('-u') && !seen.has('--unrestricted')) {
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

/**
 * Local git in a repository inside the workspace: the work of making a
 * change (branch, stage, commit, rebase, fetch), never publishing it. Push
 * is judged separately.
 *
 * Every subcommand has an allowlist of flags, and anything not on it asks.
 * Git's option surface is large and several innocent-looking options read a
 * file or run a program (`rebase -x`, `tag -F`, `--pathspec-from-file`), so
 * a list of refusals would keep missing one; a list of what's known to be
 * local and harmless fails closed instead.
 *
 * Unlike reads, these change things, so the policy applies them only to a
 * conversation the external-content gate hasn't closed. Commit, merge, and
 * rebase run the repository's hooks, which the agent's own repository only
 * has if somebody put them there; that's the policy-not-sandbox limit, and
 * the docs say so.
 */
interface GitSubcommand {
  /** Flags with no value. Short ones may be bundled. */
  flags?: string[];
  /** Flags that take a value, separately (`-m msg`), attached (`-mmsg`, `--message=msg`). */
  values?: string[];
  /** `-4` as a count. */
  numeric?: boolean;
  /** When set, the first positional must be one of these (`stash pop`). */
  actions?: string[];
  /** Positionals must not be refspec-shaped (`+src:dst`, `:dst`). */
  refspecs?: boolean;
}

const LOG_FLAGS = [
  '--oneline', '--graph', '--decorate', '--no-decorate', '--all', '--stat', '--shortstat', '--numstat', '--name-only', '--name-status',
  '-p', '--patch', '--no-patch', '-s', '--reverse', '--first-parent', '--no-merges', '--merges', '--abbrev-commit', '--follow', '--color',
  '--no-color', '-w', '--ignore-all-space', '--date-order', '--topo-order', '--left-right', '--cherry-pick', '--boundary',
];
const LOG_VALUES = ['-n', '--max-count', '--format', '--pretty', '--since', '--after', '--until', '--before', '--author', '--committer', '--grep', '--date', '-S', '-G', '-U', '--unified', '--skip', '--abbrev'];
const DIFF_FLAGS = [
  '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--cached', '--staged', '-p', '--patch', '--word-diff', '--color',
  '--no-color', '--check', '-w', '--ignore-all-space', '-b', '--ignore-space-change', '--exit-code', '--quiet', '-R', '--merge-base', '--summary',
];

const GIT_SUBCOMMANDS: Record<string, GitSubcommand> = {
  status: { flags: ['-s', '--short', '-b', '--branch', '--porcelain', '--long', '-u', '--untracked-files', '--ignored', '-z', '-v', '--verbose'] },
  log: { flags: LOG_FLAGS, values: LOG_VALUES, numeric: true },
  shortlog: { flags: ['-s', '--summary', '-n', '--numbered', '-e', '--email'], numeric: true },
  diff: { flags: DIFF_FLAGS, values: ['-U', '--unified', '--diff-filter', '--stat-width'] },
  show: { flags: [...LOG_FLAGS, ...DIFF_FLAGS], values: [...LOG_VALUES, '--diff-filter'], numeric: true },
  blame: { flags: ['-w', '-s', '-e', '--porcelain', '-l', '--line-porcelain', '-M', '-C'], values: ['-L'] },
  'rev-parse': { flags: ['--abbrev-ref', '--short', '--show-toplevel', '--git-dir', '--git-common-dir', '--verify', '--is-inside-work-tree', '--symbolic-full-name', '-q', '--quiet'] },
  'ls-files': { flags: ['-m', '-o', '-d', '-s', '-c', '-u', '--others', '--modified', '--deleted', '--cached', '--stage', '--unmerged', '--exclude-standard', '-z', '--full-name'] },
  describe: { flags: ['--tags', '--always', '--dirty', '--long', '--all'], values: ['--abbrev', '--match', '--exclude'] },
  add: { flags: ['-A', '--all', '-u', '--update', '-N', '--intent-to-add', '-v', '--verbose', '-n', '--dry-run', '--renormalize'] },
  commit: { flags: ['-a', '--all', '--amend', '--no-edit', '-s', '--signoff', '-q', '--quiet', '--allow-empty', '-v', '--verbose', '--no-verify-signatures'], values: ['-m', '--message', '--fixup', '--squash', '--author', '--date'] },
  switch: { flags: ['--detach', '-d', '--track', '-t', '--no-track', '--guess', '--no-guess', '-q', '--quiet'], values: ['-c', '--create'] },
  checkout: { flags: ['--detach', '--track', '-t', '--no-track', '-q', '--quiet'], values: ['-b'] },
  restore: { flags: ['--staged', '-S', '--worktree', '-W', '-q', '--quiet'], values: ['--source', '-s'] },
  branch: {
    flags: [
      '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose', '--show-current', '--merged', '--no-merged',
      '--unset-upstream', '--track', '-t', '--no-track', '-m', '--move', '--color', '--no-color', '--no-column',
    ],
    values: ['--set-upstream-to', '-u', '--sort', '--format', '--contains', '--no-contains', '--points-at'],
  },
  // Not `remove`: git matches its argument against registered worktrees by
  // unique suffix, so `remove wt` can delete one outside the workspace.
  worktree: { flags: ['--detach', '--track', '--no-track', '-q', '--quiet', '--porcelain', '-v', '--verbose', '--checkout', '--no-checkout'], values: ['-b'], actions: ['add', 'list'] },
  stash: { flags: ['-u', '--include-untracked', '-k', '--keep-index', '--no-keep-index', '-q', '--quiet', '--index', '--staged'], values: ['-m', '--message'], actions: ['push', 'pop', 'apply', 'list', 'show', 'save'] },
  merge: { flags: ['--no-ff', '--ff-only', '--ff', '--squash', '--no-squash', '--no-edit', '--abort', '--continue', '--quit', '-q', '--quiet', '--no-commit', '--commit', '--stat', '--no-stat', '--autostash'], values: ['-m', '--message'] },
  rebase: { flags: ['--abort', '--continue', '--skip', '--quit', '--autosquash', '--no-autosquash', '--autostash', '--no-autostash', '-q', '--quiet', '--root', '--keep-empty', '--update-refs'], values: ['--onto'] },
  'cherry-pick': { flags: ['--abort', '--continue', '--skip', '--quit', '-n', '--no-commit', '-x', '--ff', '--allow-empty'], values: ['-m', '--mainline'] },
  reset: { flags: ['--soft', '--mixed', '--keep', '-q', '--quiet', '-N', '--intent-to-add'] },
  fetch: { flags: ['--all', '--tags', '--no-tags', '-q', '--quiet', '-v', '--verbose', '--unshallow', '--dry-run', '--atomic', '--no-recurse-submodules'], values: ['--depth', '--deepen', '--shallow-since'], refspecs: true },
  pull: { flags: ['--rebase', '--no-rebase', '--ff-only', '--ff', '--no-ff', '-q', '--quiet', '-v', '--verbose', '--autostash', '--no-autostash', '--no-edit'], refspecs: true },
  tag: { flags: ['-l', '--list', '-a', '--annotate', '-n'], values: ['-m', '--message', '--sort', '--contains', '--points-at'] },
  mv: { flags: ['-k', '-n', '--dry-run', '-v', '--verbose'] },
  rm: { flags: ['--cached', '-r', '-q', '--quiet', '-n', '--dry-run'] },
};

/** The flags of one subcommand, or undefined when one isn't on its list. */
const gitPositionals = (spec: GitSubcommand, rest: string[]): string[] | undefined => {
  const flags = spec.flags ?? [];
  const values = spec.values ?? [];
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token === '--') {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(token)) {
      continue;
    }
    if (token.startsWith('--')) {
      const [name] = token.split('=');
      if (token.includes('=')) {
        if (!values.includes(name ?? '') && !flags.includes(name ?? '')) {
          return undefined;
        }
        continue;
      }
      if (values.includes(token)) {
        if (rest[index + 1] === undefined) {
          return undefined;
        }
        index += 1;
        continue;
      }
      if (!flags.includes(token)) {
        return undefined;
      }
      continue;
    }
    if (flags.includes(token)) {
      continue;
    }
    if (values.includes(token)) {
      if (rest[index + 1] === undefined) {
        return undefined;
      }
      index += 1;
      continue;
    }
    // An attached value (`-mmsg`, `-U3`), or a bundle of flags (`-sb`)
    // whose last letter may take the next token as its value (`-am msg`).
    if (values.includes(token.slice(0, 2))) {
      continue;
    }
    const letters = [...token.slice(1)];
    const last = `-${letters.at(-1)}`;
    if (!letters.slice(0, -1).every((letter) => flags.includes(`-${letter}`))) {
      return undefined;
    }
    if (values.includes(last)) {
      if (rest[index + 1] === undefined) {
        return undefined;
      }
      index += 1;
      continue;
    }
    if (!flags.includes(last)) {
      return undefined;
    }
  }
  return positionals;
};

/**
 * The repository's git directories, found the way git finds them: the
 * nearest `.git` at or above `start` (but not above the workspace), which in
 * a linked worktree is a file naming its own git directory, whose
 * `commondir` names the one holding config and shared refs. Both resolved
 * through symlinks, so a `.git` file or link pointing out of the workspace
 * is seen for what it is.
 */
const gitDirsOf = async (start: string, root: string): Promise<{ gitDir: string; commonDir: string } | undefined> => {
  for (let dir = start; within(root, dir); dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    const pointer = await readFile(dotGit, 'utf8').catch(() => undefined);
    let gitDir: string | undefined;
    if (pointer !== undefined) {
      const match = /^gitdir: (.+)$/m.exec(pointer);
      gitDir = match ? await resolveReal(path.resolve(dir, (match[1] as string).trim())) : undefined;
      if (gitDir === undefined) {
        return undefined;
      }
    } else if (await readFile(path.join(dotGit, 'HEAD'), 'utf8').then(() => true, () => false)) {
      gitDir = await resolveReal(dotGit);
    }
    if (gitDir !== undefined) {
      const common = await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => undefined);
      const commonDir = common === undefined ? gitDir : await resolveReal(path.resolve(gitDir, common.trim()));
      return commonDir === undefined ? undefined : { gitDir, commonDir };
    }
    if (dir === root) {
      return undefined;
    }
  }
  return undefined;
};

/**
 * The remotes a repository configures, or undefined when its config can't
 * be trusted to say. `for: 'fetch'` needs a `url`; git ignores `pushurl`
 * when fetching and reads the name as a path instead.
 */
const configuredRemotes = async (commonDir: string, use: 'fetch' | 'push' = 'push'): Promise<string[] | undefined> => {
  const config = await readFile(path.join(commonDir, 'config'), 'utf8').catch(() => '');
  // An include pulls config from a file this check never reads, and a
  // backslash-continued line folds what looks like a header into a value:
  // either way this line-based reading isn't git's, so nothing counts.
  if (/^\s*\[include(?:If)?\b/im.test(config) || /\\\s*$/m.test(config)) {
    return undefined;
  }
  // A remote only counts with a URL: without one git reads the name as a
  // path (`[remote ".."]` would push to the parent directory). `.` and `..`
  // are paths whatever the config says.
  const sections = config.split(/^(?=\s*\[)/m);
  return sections
    // Section names are case-insensitive to git; subsection names aren't.
    .map((section) => ({ name: /^\s*\[remote "([^"]+)"\]/i.exec(section)?.[1], section }))
    .filter((entry): entry is { name: string; section: string } => entry.name !== undefined && entry.name !== '.' && entry.name !== '..'
      && (use === 'fetch' ? /^\s*url\s*=\s*\S/im : /^\s*(?:push)?url\s*=\s*\S/im).test(entry.section))
    .map((entry) => entry.name);
};

/**
 * The remote a bare `git fetch`/`git pull` uses: the checked-out branch's
 * `branch.<name>.remote`, or `origin`. Undefined when HEAD isn't a branch or
 * the config includes a file this can't read.
 */
const upstreamRemote = async (dirs: { gitDir: string; commonDir: string }): Promise<string | undefined> => {
  const head = await readFile(path.join(dirs.gitDir, 'HEAD'), 'utf8').catch(() => '');
  const branch = /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
  if (branch === undefined) {
    return undefined;
  }
  const config = await readFile(path.join(dirs.commonDir, 'config'), 'utf8').catch(() => '');
  if (/^\s*\[include(?:If)?\b/im.test(config)) {
    return undefined;
  }
  for (const section of config.split(/^(?=\s*\[)/m)) {
    const header = /^\s*\[branch "([^"]+)"\]/i.exec(section);
    if (header?.[1] === branch) {
      const remote = /^\s*remote\s*=\s*(.+?)\s*$/im.exec(section.slice(header[0].length))?.[1];
      if (remote !== undefined) {
        return remote;
      }
    }
  }
  return 'origin';
};

export const gitInsideWorkspace = async (
  analysis: CommandAnalysis,
  cwd: string,
  workspace: string,
): Promise<boolean> => {
  if (analysis.disqualifiedBy || analysis.base !== 'git' || analysis.pipeline) {
    return false;
  }
  // What the shell would expand, quoted or not, with one allowance: `~` only
  // expands at the start of a word, so `HEAD~1` is the revision it says.
  if (analysis.tokens.some((token) => token.startsWith('~') || /[*?[\]{}$`\\]/.test(token))) {
    return false;
  }
  const args = analysis.tokens.slice(1);
  // Global options: only where it runs, and whether it pages. Everything
  // else before the subcommand (`-c`, `--git-dir`, `--exec-path`) asks.
  // Each -C is relative to the one before it, as git applies them.
  const directories: string[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '-C' && args[index + 1] !== undefined) {
      directories.push(args[index + 1] as string);
      index += 1;
      continue;
    }
    if (token === '--no-pager') {
      continue;
    }
    break;
  }
  const subcommand = args[index];
  const spec = subcommand === undefined ? undefined : GIT_SUBCOMMANDS[subcommand];
  if (subcommand === undefined || spec === undefined) {
    return false;
  }
  const positionals = gitPositionals(spec, args.slice(index + 1));
  if (positionals === undefined) {
    return false;
  }
  if (spec.actions && positionals.length > 0 && !spec.actions.includes(positionals[0] as string)) {
    return false;
  }
  if (spec.refspecs && positionals.some((token) => token.startsWith('+') || token.includes(':'))) {
    // `+src:dst` is a forced update without a flag, and `:dst` a delete.
    return false;
  }
  // An editor run from config is a program nobody approved, and with no
  // terminal it can't be anything else: a commit or an annotated tag says
  // its message on the command line.
  const said = (names: string[]): boolean => args.slice(index + 1).some((token) => names.some((name) => token === name
    || token.startsWith(`${name}=`)
    // `-mmsg`, or a short bundle ending in it (`-am msg`).
    || (name.length === 2 && !token.startsWith('--') && token.startsWith('-') && token.slice(1).includes(name.slice(1)))));
  if (subcommand === 'commit' && !said(['-m', '--message', '--no-edit', '--fixup'])) {
    return false;
  }
  if (subcommand === 'tag' && said(['-a', '--annotate']) && !said(['-m', '--message'])) {
    return false;
  }

  const root = await resolveReal(workspace);
  const here = await resolveReal(cwd);
  if (root === undefined || here === undefined || !within(root, here)) {
    return false;
  }
  let repoDir: string | undefined = here;
  for (const directory of directories) {
    repoDir = repoDir === undefined ? undefined : await walk(repoDir, directory);
  }
  if (repoDir === undefined || !within(root, repoDir)) {
    return false;
  }
  // The repository git will actually use, not just the directory it runs
  // in: a `.git` file or link can name one anywhere on the host.
  const dirs = await gitDirsOf(repoDir, root);
  if (dirs === undefined || !within(root, dirs.gitDir) || !within(root, dirs.commonDir)) {
    return false;
  }
  // Fetch and pull name a repository first, and a path there reads one from
  // anywhere on the host: only a remote the repository configures.
  // With no repository named, the checked-out branch's `branch.<x>.remote`
  // decides (`origin` when unset), and that must be a configured remote too.
  if (subcommand === 'fetch' || subcommand === 'pull') {
    const remotes = await configuredRemotes(dirs.commonDir, 'fetch');
    const named = positionals.length > 0 ? positionals[0] as string : await upstreamRemote(dirs);
    if (remotes === undefined || named === undefined || !remotes.includes(named)) {
      return false;
    }
  }
  // `git mv` writes its destination, and a symlinked directory on the way
  // can put it outside: every path it names must land inside.
  if (subcommand === 'mv') {
    for (const target of positionals) {
      const landed = await walk(repoDir, target);
      if (landed === undefined || !within(root, landed)) {
        return false;
      }
    }
  }
  // A worktree is a directory git creates or removes: it must land inside
  // too. `git worktree add [-b <branch>] <path> [<commit>]`.
  if (subcommand === 'worktree') {
    const [action, target] = positionals;
    if (action === 'list') {
      return true;
    }
    if (target === undefined) {
      return false;
    }
    const landed = await walk(repoDir, target);
    return landed !== undefined && within(root, landed) && landed !== root;
  }
  return true;
};

/**
 * Whether any config git reads for this repository sets a push mapping, in
 * any of its spellings (`[remote "origin"]` or the older `[remote.origin]`),
 * including a worktree's own `config.worktree`. Any `push =` key at all
 * counts: the only `push` key git has is `remote.<name>.push`, and reading
 * every form exactly is a parser this check doesn't need to be.
 */
const anyPushMapping = async (gitDir: string, commonDir: string): Promise<boolean> => {
  for (const file of [path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree'), path.join(commonDir, 'config.worktree')]) {
    const config = await readFile(file, 'utf8').catch(() => '');
    // `push.followTags` publishes reachable annotated tags with the branch.
    // Any `followTags` key (a bare one is true) publishes tags with the
    // branch, and submodule recursion pushes repositories nobody checked.
    if (/^\s*push\s*=/im.test(config) || /^\s*followtags\b/im.test(config) || /^\s*recursesubmodules\b/im.test(config)
      || /^\s*recurse\b/im.test(config) || /^\s*\[include(?:If)?\b/im.test(config)) {
      return true;
    }
  }
  return false;
};

/** Whether a ref exists, loose or packed. */
const refExists = async (commonDir: string, ref: string): Promise<boolean> => {
  if (await readFile(path.join(commonDir, ref), 'utf8').then(() => true, () => false)) {
    return true;
  }
  const packed = await readFile(path.join(commonDir, 'packed-refs'), 'utf8').catch(() => '');
  return packed.split('\n').some((line) => line.endsWith(` ${ref}`));
};

/**
 * Publishing the agent's own work: `git push <remote> <refspec>` of a
 * branch whose name starts with one of the agent's prefixes (`nova/` by
 * default), to a remote configured in the repository. Nothing lands from
 * here without review, which is what makes this safe to run unattended.
 *
 * Judged by what git will actually update, so only forms whose destination
 * is certain from the command and the repository: an explicit remote and
 * one refspec. A bare `git push` or `git push origin` asks, because
 * `remote.<name>.push` and `push.default` decide its destination. `HEAD` is
 * the checked-out branch, pushed to the same name. An unqualified name is
 * a branch only if it is a local branch and not also a tag.
 *
 * Refused: force in any spelling (`--force*`, `-f`, a `+` refspec), deletes
 * (`--delete`, `:branch`), `--all`, `--mirror`, `--tags`, any other flag, a
 * remote that isn't configured (a URL, a path, or a directory that happens
 * to have a name's spelling), and any branch outside the prefixes.
 */
export const gitPushInsideWorkspace = async (
  analysis: CommandAnalysis,
  cwd: string,
  workspace: string,
  branchPrefixes: readonly string[],
): Promise<boolean> => {
  if (analysis.disqualifiedBy || analysis.base !== 'git' || analysis.pipeline || branchPrefixes.length === 0) {
    return false;
  }
  if (analysis.tokens.some((token) => token.startsWith('~') || /[*?[\]{}$`\\]/.test(token))) {
    return false;
  }
  const args = analysis.tokens.slice(1);
  const directories: string[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '-C' && args[index + 1] !== undefined) {
      directories.push(args[index + 1] as string);
      index += 1;
      continue;
    }
    if (token === '--no-pager') {
      continue;
    }
    break;
  }
  if (args[index] !== 'push') {
    return false;
  }
  const allowedFlags = new Set(['-u', '--set-upstream', '--dry-run', '-n', '-q', '--quiet', '-v', '--verbose', '--porcelain']);
  const positionals: string[] = [];
  for (const token of args.slice(index + 1)) {
    if (token.startsWith('-')) {
      if (!allowedFlags.has(token)) {
        return false;
      }
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 2) {
    return false;
  }
  const [remote, refspec] = positionals as [string, string];
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || refspec.startsWith('+') || refspec.startsWith(':')) {
    return false;
  }

  const root = await resolveReal(workspace);
  const here = await resolveReal(cwd);
  if (root === undefined || here === undefined || !within(root, here)) {
    return false;
  }
  let repoDir: string | undefined = here;
  for (const directory of directories) {
    repoDir = repoDir === undefined ? undefined : await walk(repoDir, directory);
  }
  if (repoDir === undefined || !within(root, repoDir)) {
    return false;
  }
  const dirs = await gitDirsOf(repoDir, root);
  if (dirs === undefined || !within(root, dirs.gitDir) || !within(root, dirs.commonDir)) {
    return false;
  }
  // Configured, not merely name-shaped: git reads an unconfigured name as a
  // path, and a directory by that name would receive the push.
  const remotes = await configuredRemotes(dirs.commonDir);
  if (remotes === undefined || !remotes.includes(remote)) {
    return false;
  }
  // A remote with its own push mapping sends `nova/x` wherever that says,
  // so the refspec on the line no longer names the destination.
  if (await anyPushMapping(dirs.gitDir, dirs.commonDir)) {
    return false;
  }

  const parts = refspec.split(':');
  if (parts.length > 2) {
    return false;
  }
  const [source, destination] = parts as [string, string | undefined];
  let branch: string | undefined;
  if (source === 'HEAD') {
    const head = await readFile(path.join(dirs.gitDir, 'HEAD'), 'utf8').catch(() => '');
    const current = /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
    if (current === undefined) {
      return false;
    }
    branch = current;
  } else {
    const name = source.replace(/^refs\/heads\//, '');
    // A source git would read as something other than a local branch makes
    // the destination something other than a branch, or unknowable.
    if (source.startsWith('refs/') && !source.startsWith('refs/heads/')) {
      return false;
    }
    if (!await refExists(dirs.commonDir, `refs/heads/${name}`) || await refExists(dirs.commonDir, `refs/tags/${name}`)) {
      return false;
    }
    branch = name;
  }
  if (destination !== undefined) {
    if (destination.startsWith('refs/')) {
      if (!destination.startsWith('refs/heads/')) {
        return false;
      }
      branch = destination.slice('refs/heads/'.length);
    } else {
      branch = destination;
    }
  }
  return branch.length > 0 && branchPrefixes.some((prefix) => branch.startsWith(prefix) && branch.length > prefix.length);
};
