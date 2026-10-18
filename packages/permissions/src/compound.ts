import { readdir } from 'node:fs/promises';

import { analyzeCommand, findMatchingScope, type CommandAnalysis, type CommandScope } from './commands.ts';
import { resolveReal, walk, within } from './workspace.ts';

/**
 * Compound commands and grants by command name.
 *
 * The scope engine in `commands.ts` judges one command, or one pipeline,
 * and refuses anything with `&&`, `;`, `||` or a redirection in it. That is
 * most of what an agent types (`cd app && grep -rn todo . | head`), so a
 * person was asked about every one of them however much they had already
 * approved. This reads such a line as the shell will — a list of pipelines,
 * each a list of commands with their redirections — and runs it unattended
 * only when every command in it would run on its own and every redirection
 * lands where the agent may write.
 *
 * It also holds the other half of the change: a grant on a command *by
 * name*. Approving `grep` once covers every `grep`, whatever its flags and
 * pattern, as long as everything it is pointed at is inside the agent's
 * workspace. The arguments are no longer what the grant is about; where they
 * lead is. So a by-name grant is offered only for the commands on a short
 * list whose every effect is reading and writing the paths they are given
 * (`GRANTABLE_BY_NAME`), less any flag that runs a program or reads a list
 * of further paths. Everything else keeps the narrower scopes the engine
 * has always stored: a list of what may not be granted could never be
 * finished, since a test runner, a linter or `tar --checkpoint-action` runs
 * code no path check sees.
 *
 * Still argument-level policy, not a sandbox, and still failing toward a
 * prompt: an operator, a quote or an expansion this reader does not model
 * leaves the line to a person.
 */

/** One redirection: where a command's output goes or its input comes from. */
export interface Redirect {
  /** `out` for `>`, `>>`, `&>`; `in` for `<`. A descriptor copy (`2>&1`) is not recorded. */
  direction: 'out' | 'in';
  /** The path as written, unquoted. */
  target: string;
}

/** One command of a pipeline, its redirections taken out. */
export interface CompoundStage {
  analysis: CommandAnalysis;
  redirects: Redirect[];
}

export interface CompoundCommand {
  command: string;
  /**
   * The pipelines in order, joined by `&&`, `||` or `;`. Which joined them
   * is not kept: the judge assumes any of them may or may not run, which is
   * the reading that cannot under-ask.
   */
  pipelines: CompoundStage[][];
  /** Why this line cannot be read as a compound command at all. */
  disqualifiedBy?: string;
}

const disqualified = (command: string, reason: string): CompoundCommand => ({ command, pipelines: [], disqualifiedBy: reason });

/** Words the shell reads as syntax when they start a command. */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in',
  'function', 'time', 'coproc', '!', '{', '}', '[[', ']]',
]);

/** A redirection target the shell would expand, or that this reader would get wrong. */
const UNREADABLE_TARGET = /[*?[\]{}~$`\\#]/;

/**
 * Read a command line as a list of pipelines.
 *
 * Splits on `&&`, `||`, `;` and `|` outside quotes, and lifts `>`, `>>`,
 * `&>`, `<` and descriptor copies out of each command. Everything else the
 * shell treats as syntax refuses the line: a lone `&` (a background job that
 * outlives the call), a newline, parentheses, `$( )`, backticks, a heredoc,
 * an unquoted backslash or `#`. What is left of each command is then read by
 * `analyzeCommand`, which refuses whatever it would refuse on its own.
 */
export const analyzeCompound = (command: string): CompoundCommand => {
  const pipelines: CompoundStage[][] = [];
  let stages: CompoundStage[] = [];
  let text = '';
  let redirects: Redirect[] = [];
  // Where the word being written began in `text`, so a descriptor number
  // written against its operator (`2>`) can be taken back out of it.
  let wordStart = 0;
  let quote: '"' | "'" | undefined;

  const endStage = (): string | undefined => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return 'it contains an empty command (a stray operator)';
    }
    const analysis = analyzeCommand(trimmed);
    if (analysis.disqualifiedBy) {
      return analysis.disqualifiedBy;
    }
    // `if true; then sh -c id; fi` split on `;` is not three commands named
    // `if`, `then` and `fi`: the keyword is syntax, and the command it
    // carries is the next word. This reader does not model it.
    if (SHELL_KEYWORDS.has(analysis.tokens[0] ?? '')) {
      return 'it contains shell syntax (if, for, while, case, braces)';
    }
    if (analysis.pipeline) {
      // `analyzeCommand` split on a pipe this reader did not see.
      return 'it could not be read as a command';
    }
    stages.push({ analysis, redirects });
    text = '';
    redirects = [];
    wordStart = 0;
    return undefined;
  };
  const endPipeline = (): string | undefined => {
    const failed = endStage();
    if (failed) {
      return failed;
    }
    pipelines.push(stages);
    stages = [];
    return undefined;
  };

  /** Read the word after a redirection operator, quotes resolved. */
  const readTarget = (from: number): { target: string; next: number } | undefined => {
    let index = from;
    while (command[index] === ' ' || command[index] === '\t') {
      index += 1;
    }
    let target = '';
    let inQuote: '"' | "'" | undefined;
    let started = false;
    for (; index < command.length; index += 1) {
      const char = command[index]!;
      if (inQuote) {
        if (char === inQuote) {
          inQuote = undefined;
        } else {
          target += char;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        inQuote = char;
        started = true;
        continue;
      }
      if (/[\s;&|<>()]/.test(char)) {
        break;
      }
      target += char;
      started = true;
    }
    if (inQuote || !started || target.length === 0 || UNREADABLE_TARGET.test(target)) {
      return undefined;
    }
    return { target, next: index };
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      text += char;
      continue;
    }
    if (quote === '"') {
      if (char === '\\' && next !== undefined) {
        text += char + next;
        index += 1;
        continue;
      }
      if (char === '"') {
        quote = undefined;
      } else if (char === '`' || (char === '$' && next === '(')) {
        return disqualified(command, 'it contains a command substitution');
      }
      text += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      text += char;
      continue;
    }
    if (char === '\\') {
      return disqualified(command, 'it contains a backslash outside quotes');
    }
    if (char === '#') {
      return disqualified(command, 'it contains a # outside quotes');
    }
    if (char === '\n' || char === '\r') {
      return disqualified(command, 'it contains a newline');
    }
    if (char === '(' || char === ')') {
      return disqualified(command, 'it contains a subshell (parentheses)');
    }
    if (char === '`' || (char === '$' && next === '(')) {
      return disqualified(command, 'it contains a command substitution');
    }
    if (char === ';') {
      const failed = endPipeline();
      if (failed) {
        return disqualified(command, failed);
      }
      continue;
    }
    if (char === '&' && next === '&') {
      const failed = endPipeline();
      if (failed) {
        return disqualified(command, failed);
      }
      index += 1;
      continue;
    }
    if (char === '|' && next === '|') {
      const failed = endPipeline();
      if (failed) {
        return disqualified(command, failed);
      }
      index += 1;
      continue;
    }
    if (char === '|') {
      if (next === '&') {
        return disqualified(command, 'it pipes standard error (|&)');
      }
      const failed = endStage();
      if (failed) {
        return disqualified(command, failed);
      }
      continue;
    }
    if (char === '>' || char === '<' || (char === '&' && next === '>')) {
      // A descriptor number is part of the operator only when it is the
      // whole word so far: `2>err` redirects stderr, `a2>err` is `a2`.
      const word = text.slice(wordStart);
      if (/^\d+$/.test(word)) {
        text = text.slice(0, wordStart);
      }
      let at = index;
      let direction: 'out' | 'in';
      if (char === '&') {
        // `&>` and `&>>`: both streams to one file.
        at += 1;
        direction = 'out';
        if (command[at + 1] === '>') {
          at += 1;
        }
      } else if (char === '>') {
        direction = 'out';
        if (next === '>') {
          at += 1;
        } else if (next === '|') {
          return disqualified(command, 'it contains a clobbering redirection (>|)');
        }
      } else {
        direction = 'in';
        if (next === '<') {
          return disqualified(command, 'it contains a heredoc (<<)');
        }
        if (next === '>') {
          return disqualified(command, 'it opens a file for reading and writing (<>)');
        }
      }
      if (command[at + 1] === '&') {
        // A descriptor copy: `2>&1`, `>&2`, `<&0`, or `>&-` to close one.
        const copy = /^&(\d+|-)/.exec(command.slice(at + 1));
        if (!copy) {
          return disqualified(command, 'it redirects to something other than a file or a descriptor');
        }
        index = at + copy[0].length;
        text += ' ';
        wordStart = text.length;
        continue;
      }
      const read = readTarget(at + 1);
      if (!read) {
        return disqualified(command, 'it redirects to a path this reader cannot be sure of');
      }
      redirects.push({ direction, target: read.target });
      index = read.next - 1;
      text += ' ';
      wordStart = text.length;
      continue;
    }
    if (char === '&') {
      return disqualified(command, 'it runs a command in the background (&)');
    }
    if (char === ' ' || char === '\t') {
      text += char;
      wordStart = text.length;
      continue;
    }
    text += char;
  }
  if (quote) {
    return disqualified(command, 'it has an unbalanced quote');
  }
  const failed = endPipeline();
  if (failed) {
    return disqualified(command, failed);
  }
  return { command, pipelines };
};

/**
 * Commands that may be granted by name: each reads or writes the paths it
 * is given and nothing else, so a check of those paths is a check of what
 * it does. Network clients, archivers, test runners, linters, build tools
 * and `jq` (whose `env` reads the daemon's environment) are not on it;
 * they keep the narrower scope. Adding one means reading its manual for
 * flags that run a program or read paths from a file, and denying them in
 * `NAME_GRANT_DENIED_BY_COMMAND`.
 */
export const GRANTABLE_BY_NAME: ReadonlySet<string> = new Set([
  'grep', 'egrep', 'fgrep', 'rg',
  'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'paste', 'join', 'comm', 'fold', 'nl', 'column', 'rev', 'tac',
  'diff', 'cmp', 'ls', 'stat', 'file', 'du', 'tree', 'realpath', 'readlink', 'basename', 'dirname',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'tee',
  'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'base64', 'od', 'xxd', 'hexdump', 'strings',
  'gzip', 'gunzip', 'zcat', 'printf', 'test',
]);

/**
 * Commands no grant may ever cover by name, and which get no scope either
 * when they appear in a line with others (`… | sh`). Each one can be
 * pointed at something no path check
 * sees: a program to run (`sh`, `python`, `xargs`, `env`, `find -exec`), a
 * privilege (`sudo`), a remote machine (`ssh`), or the machine's own
 * configuration (`launchctl`, `networksetup`, `security`, `chmod`). They
 * keep the narrower scope an "always" has always stored.
 */
export const NOT_GRANTABLE_BY_NAME: ReadonlySet<string> = new Set([
  // Privilege.
  'sudo', 'su', 'doas', 'pkexec',
  // Shells and interpreters: the argument is a program.
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'nu', 'pwsh',
  'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'osascript', 'tclsh',
  'awk', 'gawk', 'mawk', 'sed', 'jshell', 'irb',
  // Wrappers: they run whatever follows.
  'env', 'xargs', 'eval', 'exec', 'command', 'builtin', 'source', '.', 'nohup', 'timeout', 'gtimeout', 'nice',
  'time', 'watch', 'parallel', 'find', 'fd', 'npx', 'pnpx', 'bunx', 'uvx', 'script', 'expect', 'caffeinate',
  'arch', 'chroot', 'setsid', 'stdbuf', 'flock', 'strace', 'ltrace', 'dtruss', 'dtrace', 'gdb', 'lldb',
  'sandbox-exec', 'xcrun', 'entr', 'watchexec', 'nodemon', 'java', 'julia', 'R', 'Rscript', 'dotnet', 'powershell',
  // Archivers that store what a symlink points at by default.
  'zip', '7z', '7za',
  // Editors and pagers, which can shell out.
  'vi', 'vim', 'nvim', 'nano', 'emacs', 'less', 'more', 'man',
  // Other machines.
  'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'nc', 'ncat', 'socat',
  // The machine itself: services, network, credentials, ownership, disks, processes.
  'launchctl', 'systemctl', 'service', 'networksetup', 'ifconfig', 'ip', 'route', 'pfctl', 'iptables', 'scutil',
  'systemsetup', 'dscl', 'defaults', 'security', 'chown', 'chgrp', 'chmod', 'chflags', 'xattr', 'dd', 'mkfs',
  'diskutil', 'mount', 'umount', 'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'halt', 'crontab', 'at',
  'open', 'sqlite3', 'docker', 'podman',
  // Stratus itself: its state lives outside the workspace on purpose.
  'stratus',
]);

/**
 * Commands whose first word is a subcommand, so a grant on the bare name
 * would cover every subcommand: `gh pr view` and `gh repo delete`. These
 * keep the command-plus-subcommand scope the engine has always stored, with
 * its destructive-flag limits (`git push` but not `git push --force`).
 */
export const SUBCOMMAND_COMMANDS: ReadonlySet<string> = new Set([
  'git', 'gh', 'glab', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'brew', 'fly', 'flyctl', 'agentboard', 'gcloud',
  'aws', 'az', 'terraform', 'kubectl', 'helm', 'pip', 'pip3', 'uv', 'poetry', 'rustup', 'swift', 'xcodebuild',
  'gem', 'bundle', 'make', 'apt', 'apt-get', 'dnf', 'yum', 'corepack', 'nvm', 'mise', 'asdf', 'tmux',
]);

/** Whether "always" on this command may grant it by name. */
export const grantableByName = (base: string): boolean =>
  GRANTABLE_BY_NAME.has(base)
  && !NOT_GRANTABLE_BY_NAME.has(base)
  && !SUBCOMMAND_COMMANDS.has(base);

/**
 * Flags a by-name grant still refuses: those that turn a command into
 * another program or a configuration change. Not `-c`, which the scope
 * engine refuses everywhere for `git -c` and which is `--count` or
 * `--bytes` to the commands a by-name grant is for; git never gets one.
 */
const NAME_GRANT_DENIED_FLAGS = ['--exec', '--exec-path', '--config', '--config-env', '--upload-pack', '--receive-pack', '--ext-diff', '--open-files-in-pager'];

/**
 * Per command, the flags a by-name grant does not cover: a long name, or a
 * short letter anywhere in a bundle. They run a program (`rg --pre`, `sort
 * --compress-program`), read the paths to act on from a file this check
 * never opens (`--files0-from`, `file -f`, `md5sum -c`), or walk links
 * below the given paths by default (`diff -r`).
 */
const NAME_GRANT_DENIED_BY_COMMAND: Record<string, string[]> = {
  rg: ['--pre', '--pre-glob'],
  sort: ['--compress-program', '--files0-from'],
  wc: ['--files0-from'],
  du: ['--files0-from'],
  diff: ['--recursive', 'r'],
  file: ['--files-from', 'f'],
  md5sum: ['--check', 'c'],
  shasum: ['--check', 'c'],
  sha1sum: ['--check', 'c'],
  sha256sum: ['--check', 'c'],
  sha512sum: ['--check', 'c'],
};

const deniedFor = (base: string, args: readonly string[]): boolean => {
  const denied = NAME_GRANT_DENIED_BY_COMMAND[base] ?? [];
  return args.some((token) => {
    if (token === '--') {
      return false;
    }
    if (token.startsWith('--')) {
      const spelled = token.split('=')[0] ?? token;
      return NAME_GRANT_DENIED_FLAGS.includes(spelled) || denied.includes(spelled);
    }
    return token.startsWith('-') && [...token.slice(1)].some((letter) => denied.includes(letter));
  });
};

/**
 * Short flags that make a command follow symlinks it meets *below* the
 * paths it was given, which a check of those paths cannot see: `grep -R`
 * walks a link to `/` like any directory, where `grep -r` does not. A
 * by-name grant does not cover them; the call asks.
 */
const FOLLOWS_LINKS: Record<string, string[]> = {
  grep: ['R'],
  egrep: ['R'],
  fgrep: ['R'],
  rg: ['L'],
  cp: ['L', 'H'],
  du: ['L'],
  ls: ['L'],
  tree: ['l'],
};
const FOLLOWS_LINKS_LONG = ['--dereference-recursive', '--dereference', '--follow', '--dereference-command-line'];

/** The readers that never ask inside the workspace, with or without autonomy. */
const WORKSPACE_READERS = new Set(['cat', 'head', 'tail', 'ls']);

/**
 * Every string in a command's arguments that could name a path: each
 * positional, the value of `--flag=value`, and the tail of a short flag
 * that carries one (`-o/tmp/x`, `-I../include`). Over-inclusive on purpose:
 * a grep pattern is checked as though it were a path, which costs a prompt
 * for a pattern like `/etc/` and never a read nobody approved.
 */
const pathCandidates = (args: string[]): string[] => {
  const candidates: string[] = [];
  for (const token of args) {
    if (token === '-' || token === '--') {
      continue;
    }
    if (token.startsWith('--')) {
      const at = token.indexOf('=');
      if (at !== -1) {
        candidates.push(token.slice(at + 1));
      }
      continue;
    }
    if (token.startsWith('-')) {
      const at = token.indexOf('=');
      if (at !== -1) {
        candidates.push(token.slice(at + 1));
      } else if (token.length > 2) {
        candidates.push(token.slice(2));
      }
      continue;
    }
    candidates.push(token);
  }
  // A path can hide inside a word as well as be one: `file=@/etc/hosts`,
  // `-d@~/.netrc`, `a,b,/c`. Every remainder after a separator is checked
  // too. A web URL is not a local path and is left alone; any other
  // scheme (`file://`) is judged as one.
  const expanded: string[] = [];
  for (const candidate of candidates) {
    if (/^https?:\/\//i.test(candidate)) {
      continue;
    }
    expanded.push(candidate);
    for (let at = 0; at < candidate.length; at += 1) {
      if ('=@,'.includes(candidate[at]!)) {
        expanded.push(candidate.slice(at + 1));
      }
    }
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:(.*)$/.exec(candidate);
    if (scheme) {
      expanded.push(scheme[1]!.replace(/^\/\/[^/]*/, ''));
    }
  }
  return expanded.filter((candidate) => candidate.length > 0);
};

const GLOB = /[*?[]/;

/**
 * A shell pattern for one path segment, as a regular expression that
 * matches at least what the shell would. A bracket expression is read as
 * any one character, which over-matches and so only ever checks more.
 */
const segmentPattern = (pattern: string): RegExp => {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 2);
      source += '.';
      if (close !== -1) {
        index = close;
      }
    } else {
      source += char.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 's');
};

/**
 * Whether a word the shell will glob expands only to paths inside `root`,
 * from each of `cwds`. Only a pattern in the last segment is judged, so the
 * directory it matches in is known; each entry it matches must stay inside,
 * symlinks followed, since `cat src/*` follows a link in `src` like a file.
 * A pattern matching nothing is passed through as text, which is the
 * caller's to judge.
 */
const globLandsInside = async (word: string, cwds: readonly string[], root: string): Promise<boolean> => {
  const slash = word.lastIndexOf('/');
  const directory = slash === -1 ? '.' : word.slice(0, slash + 1);
  const last = word.slice(slash + 1);
  if (GLOB.test(directory) || directory.split('/').includes('..')) {
    return false;
  }
  const matcher = segmentPattern(last);
  for (const cwd of cwds) {
    const resolved = await walk(cwd, directory);
    if (resolved === undefined || !within(root, resolved)) {
      return false;
    }
    let entries: string[];
    try {
      entries = await readdir(resolved);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && !last.startsWith('.')) {
        continue;
      }
      if (!matcher.test(entry)) {
        continue;
      }
      const landed = await walk(resolved, entry);
      if (landed === undefined || !within(root, landed)) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Whether `candidate`, read as a literal path from each of `cwds`, stays
 * inside `root`. `~`, `$`, braces and backticks have no literal reading.
 */
const landsInside = async (candidate: string, cwds: readonly string[], root: string): Promise<boolean> => {
  if (/[$`{}~\\]/.test(candidate)) {
    return false;
  }
  for (const cwd of cwds) {
    const resolved = await walk(cwd, candidate);
    if (resolved === undefined || !within(root, resolved)) {
      return false;
    }
  }
  return true;
};

/**
 * A by-name grant on this command, if one is on file and the call keeps to
 * the workspace: it runs in it, and every argument that could be a path
 * resolves inside it, symlinks followed.
 */
const coveredByName = async (
  stage: CommandAnalysis,
  names: ReadonlySet<string>,
  cwds: readonly string[],
  root: string,
): Promise<boolean> => {
  const base = stage.base;
  if (base === undefined || !names.has(base) || !grantableByName(base)) {
    return false;
  }
  const args = stage.tokens.slice(1);
  if (deniedFor(base, args)) {
    return false;
  }
  if (stage.tokens.some((token) => /[$`]/.test(token))) {
    return false;
  }
  const follows = FOLLOWS_LINKS[base] ?? [];
  if (args.some((token) => {
    if (token.startsWith('--')) {
      return FOLLOWS_LINKS_LONG.includes(token.split('=')[0] ?? token);
    }
    return token.startsWith('-') && [...token.slice(1)].some((letter) => follows.includes(letter));
  })) {
    return false;
  }
  for (const [index, token] of args.entries()) {
    // The shell globs the whole word, before any of it means anything to
    // the command: `--include=*.ts` matches files named `--include=…`.
    if (stage.expands?.[index + 1] && GLOB.test(token) && !(await globLandsInside(token, cwds, root))) {
      return false;
    }
  }
  for (const candidate of pathCandidates(args)) {
    if (!(await landsInside(candidate, cwds, root))) {
      return false;
    }
  }
  return true;
};

/** What the judge needs to know about the agent and its grants. */
export interface CompoundJudgeOptions {
  /** Where the shell starts. Undefined: nothing that depends on it is covered. */
  cwd: string | undefined;
  /**
   * The agent's workspace, for by-name grants, redirections, and the plain
   * workspace readers. Undefined: none of those is covered.
   */
  root: string | undefined;
  /** The built-in safe scopes. */
  safeScopes: readonly CommandScope[];
  /** Granted command scopes (empty under the external-content gate). */
  scopes: readonly CommandScope[];
  /** Commands granted by name (empty under the external-content gate). */
  names: readonly string[];
  /**
   * Workspace autonomy for one command in one directory, when it is on:
   * the reads, local git, and downloads `index.ts` already judges.
   */
  autonomous?: (stage: CommandAnalysis, cwd: string) => Promise<boolean>;
  /** The plain workspace readers' check, `readsInsideWorkspace`. */
  reads: (stage: CommandAnalysis, cwd: string, root: string) => Promise<boolean>;
}

export interface CompoundJudgement {
  covered: boolean;
  /** The commands nothing covered, in order, for the prompt and for "always". */
  uncovered: CompoundStage[];
  /**
   * The commands whose own grant would not have helped: a redirection
   * outside the workspace, a directory change this reader could not
   * follow. "Always" cannot make these run unattended.
   */
  unfixable: boolean;
}

/** Where a redirection may point: the workspace, or `/dev/null`. */
const redirectsInside = async (redirects: readonly Redirect[], cwds: readonly string[] | undefined, root: string | undefined): Promise<boolean> => {
  for (const redirect of redirects) {
    if (redirect.direction === 'out' && redirect.target === '/dev/null') {
      continue;
    }
    if (root === undefined || cwds === undefined || !(await landsInside(redirect.target, cwds, root))) {
      return false;
    }
  }
  return true;
};

/**
 * Whether every command of a compound line would run unattended where it
 * runs.
 *
 * Directories are followed through `cd` as a set, not a single answer: a
 * `cd` that fails leaves the line where it was, and after `;` or `||` the
 * next command runs there. Every directory the line could be in must pass.
 * A `cd` this reader cannot follow (no argument, `-`, a `~`) is itself
 * fine, since changing directory touches nothing, but it leaves nothing
 * after it that depends on the directory covered.
 */
export const judgeCompound = async (compound: CompoundCommand, options: CompoundJudgeOptions): Promise<CompoundJudgement> => {
  const uncovered: CompoundStage[] = [];
  let unfixable = false;
  const root = options.root === undefined ? undefined : await resolveReal(options.root);
  const start = options.cwd === undefined ? undefined : await resolveReal(options.cwd);
  let cwds: string[] | undefined = start === undefined ? undefined : [start];
  const names = new Set(options.names);
  const insideRoot = (): boolean =>
    root !== undefined && cwds !== undefined && cwds.every((cwd) => within(root, cwd));

  for (const pipeline of compound.pipelines) {
    // A granted scope composes in a pipe only with other scopes, as it
    // does on its own (`findCoveringScopes`): a `gh api` scope must not
    // become the far end of `cat notes | gh api … --input -` because the
    // read is in the workspace. A by-name grant may, since everything it
    // could send it could already name as a path.
    const alone = pipeline.length === 1
      || pipeline.every((stage) => findMatchingScope(stage.analysis, [...options.scopes, ...options.safeScopes]) !== undefined);
    const targets: string[] = [];
    for (const stage of pipeline) {
      const { analysis } = stage;
      if (analysis.base === 'cd') {
        if (!(await redirectsInside(stage.redirects, cwds, root))) {
          uncovered.push(stage);
          unfixable = true;
          continue;
        }
        // In a pipeline `cd` runs in a subshell and moves nothing.
        if (pipeline.length > 1) {
          continue;
        }
        const args = analysis.tokens.slice(1);
        const target = args.length === 1 && !args[0]!.startsWith('-') && !analysis.expands?.[1] ? args[0]! : undefined;
        if (target === undefined || cwds === undefined) {
          cwds = undefined;
          continue;
        }
        for (const cwd of cwds) {
          const landed = await walk(cwd, target);
          if (landed === undefined) {
            cwds = undefined;
            break;
          }
          targets.push(landed);
        }
        continue;
      }
      let covered = findMatchingScope(analysis, options.safeScopes) !== undefined
        || (alone && findMatchingScope(analysis, options.scopes) !== undefined);
      if (!covered && cwds !== undefined && root !== undefined && insideRoot()) {
        covered = await coveredByName(analysis, names, cwds, root);
        if (!covered && WORKSPACE_READERS.has(analysis.base ?? '')) {
          covered = (await Promise.all(cwds.map((cwd) => options.reads(analysis, cwd, root)))).every(Boolean);
        }
      }
      if (!covered && cwds !== undefined && options.autonomous) {
        covered = (await Promise.all(cwds.map((cwd) => options.autonomous!(analysis, cwd)))).every(Boolean);
      }
      if (!(await redirectsInside(stage.redirects, cwds, root))) {
        uncovered.push(stage);
        unfixable = true;
        continue;
      }
      if (!covered) {
        uncovered.push(stage);
        if (cwds === undefined || !insideRoot()) {
          unfixable = true;
        }
      }
    }
    if (cwds !== undefined && targets.length > 0) {
      cwds = [...new Set([...cwds, ...targets])];
    }
  }
  return { covered: uncovered.length === 0, uncovered, unfixable };
};

/** A name for a log line: the commands of a line, never their arguments. */
export const compoundCommandNames = (stages: readonly CompoundStage[]): string[] =>
  [...new Set(stages.map((stage) => stage.analysis.base).filter((base): base is string => base !== undefined))];

/** A standing grant on a command by name, as the whitelist file holds it. */
export interface CommandNameGrant {
  /** The command, as the shell is given it: `grep`, never a path. */
  command: string;
  /** When the operator answered, ISO-8601. */
  grantedAt: string;
  /** Who answered, in the ids of the channel that asked; absent at a terminal. */
  grantedBy?: string;
}

/**
 * Read one by-name grant out of a whitelist file, or refuse it. A command
 * that can never be granted by name is refused here as well as when
 * matching, so a hand-edited `sudo` is dropped from the listing rather than
 * shown as a grant that does nothing.
 */
export const parseCommandNameGrant = (raw: unknown): CommandNameGrant | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.command !== 'string' || !grantableByName(source.command)) {
    return undefined;
  }
  return {
    command: source.command,
    grantedAt: typeof source.grantedAt === 'string' ? source.grantedAt : new Date(0).toISOString(),
    ...(typeof source.grantedBy === 'string' && source.grantedBy.length > 0 ? { grantedBy: source.grantedBy } : {}),
  };
};
