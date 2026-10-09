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

/**
 * The parts of a command the shell reads as syntax. `active` is everything
 * outside single quotes, where `$(`, backticks and `${` still run; `bare` is
 * everything outside any quotes, the only place `(`, `;`, `|` and the rest
 * are operators. A quoted region is replaced by a space rather than dropped,
 * so the text on either side of it can never join into an operator the
 * shell would not see.
 *
 * Undefined when this reading could disagree with `sh`: a backslash outside
 * single quotes escapes a quote, which this scanner does not model, and an
 * unbalanced quote has no reading at all. The caller then checks the whole
 * string, quotes included, the way it always has.
 */
const syntaxOf = (command: string): { active: string; bare: string } | undefined => {
  let active = '';
  let bare = '';
  let quote: '"' | "'" | undefined;
  for (const char of command) {
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
        active += ' ';
        bare += ' ';
      }
      continue;
    }
    if (char === '\\') {
      return undefined;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
        bare += ' ';
      } else {
        active += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      active += ' ';
      continue;
    }
    if (char === '#') {
      // An unquoted `#` can start a comment, inside which `sh` ignores
      // quotes up to the newline — so a quote there would put this scanner
      // in quoted mode over text the shell runs. Not modelled; checked
      // whole instead.
      return undefined;
    }
    active += char;
    bare += char;
  }
  return quote ? undefined : { active, bare };
};

/** Operators the shell still honors inside double quotes. */
const EXPANDS_IN_DOUBLE_QUOTES = new Set(['command substitution ($( ))', 'command substitution (backticks)', 'a parameter expansion (${ })']);

const analyzeSimple = (command: string): CommandAnalysis => {
  // A `(` in a commit message is text, not a subshell: operators are looked
  // for where the shell would read them, unless the quoting is too subtle
  // to be sure of, in which case every character counts.
  const syntax = syntaxOf(command);
  for (const operator of CONTROL_OPERATORS) {
    const where = syntax === undefined
      ? command
      : EXPANDS_IN_DOUBLE_QUOTES.has(operator.name) ? syntax.active : syntax.bare;
    if (operator.pattern.test(where)) {
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

/** Git subcommands whose own `-c` creates or reuses, never configures. */
const GIT_SUBCOMMANDS_WITH_PLAIN_C = new Set(['switch', 'commit']);

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
  // `-c` is refused everywhere for `git -c`, which sets config before the
  // subcommand. After a subcommand it is that subcommand's own flag:
  // `git switch -c` creates a branch, `git commit -c` reuses a message.
  // Only the tail past the subcommand is relieved; the subcommand itself is
  // a literal required argument, so `-c` cannot be it.
  // Only for subcommands whose `-c` is known not to set config: `clone -c`
  // does exactly what `git -c` does (`core.sshCommand=…`).
  // Past every leading `-C <repo>` pair: git applies each in turn.
  let subcommandAt = 0;
  while (scope.command === 'git' && required[subcommandAt] === '-C' && required[subcommandAt + 1] !== undefined) {
    subcommandAt += 2;
  }
  // Only the `-c` the shared list contributes; a scope that names `-c` in
  // its own `deniedFlags` still means it.
  const deniedInTail = scope.command === 'git' && GIT_SUBCOMMANDS_WITH_PLAIN_C.has(required[subcommandAt] ?? '')
    ? [...ALWAYS_DENIED_FLAGS.filter((flag) => flag !== '-c'), ...(scope.deniedFlags ?? [])]
    : denied;
  // A required token can itself be a flag or a refspec — an exact scope
  // carries the whole approved command — and a whitelist file is
  // hand-editable, so the prefix is held to the same rules as the rest.
  for (const [index, token] of args.slice(0, required.length).entries()) {
    // A leading `-C <repo>` in a git scope is git's own directory flag, put
    // there by `normalizeCommandScope`; the subcommand's refusal of `-C`
    // (`git branch -C` copies) is about the tokens after the subcommand.
    // Its operand is a path, not an argument of the subcommand's, so the
    // subcommand's denied arguments and git's refspec rule do not apply to
    // it either: `git -C add remote` is the `remote` subcommand in `add`.
    if (scope.command === 'git' && subcommandAt > 0 && required.length > subcommandAt && index < subcommandAt) {
      continue;
    }
    if (token.startsWith('-')) {
      // Past the subcommand, the same relief the tail gets (`['switch', '-c']`).
      if (deniesFlag(index > subcommandAt ? deniedInTail : denied, token)) {
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
    // After `--` a dash token is an operand to a program that honors it and
    // a flag to one that doesn't, and the two can't both be checked as
    // written: it asks.
    // The required prefix counts: a scope may itself end in `--`.
    if (token.startsWith('-') && args.slice(0, required.length + index).includes('--')) {
      return false;
    }
    if (token.startsWith('-')) {
      // `-cfix` is `-c fix`: the rest is the branch (or commit) it takes,
      // not more flags, unless the scope itself denies `-c`.
      // A short bundle with `c` in it (`-cfix`, `-qvcHEAD`): the letters
      // before `c` are flags, and everything after it is `-c`'s value.
      const at = !token.startsWith('--') ? token.indexOf('c', 1) : -1;
      if (deniedInTail !== denied && at > 0 && token.length > at + 1) {
        const before = [...token.slice(1, at)].map((letter) => `-${letter}`);
        for (const flag of [...before, '-c']) {
          // The same checks each flag meets on its own, minus reading the
          // value as more flags; `-c` against the scope's own denials only.
          const refusals = flag === '-c' ? scope.deniedFlags ?? [] : deniedInTail;
          if (deniesFlag(refusals, flag) || (scope.allowedFlags && !allowsFlag(scope.allowedFlags, flag))) {
            return false;
          }
        }
        continue;
      }
      if (deniesFlag(deniedInTail, token)) {
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
  // `git -C <repo> <subcommand> …` is `git <subcommand> …` run in <repo>,
  // and an agent with worktrees spells nearly every git call this way. The
  // repository is kept in the scope, literally, so a grant for one worktree
  // says nothing about another; past it the subcommand is judged as it
  // would be without -C. Only the leading position: anywhere else -C sits
  // among flags of unknown arity, and the exact-command rule below applies.
  if (analysis.base === 'git' && analysis.tokens[1] === '-C' && analysis.tokens.length > 3) {
    const repo = analysis.tokens[2] as string;
    if (repo.length > 0 && !repo.startsWith('-') && !analysis.expands?.[2] && !/[*?[\]{}~$\\#]/.test(repo)) {
      const inner = normalizeCommandScope({
        ...analysis,
        tokens: ['git', ...analysis.tokens.slice(3)],
        ...(analysis.expands ? { expands: [analysis.expands[0] ?? false, ...analysis.expands.slice(3)] } : {}),
      });
      return inner === undefined ? undefined : { ...inner, args: ['-C', repo, ...(inner.args ?? [])] };
    }
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

  // The stored argument is what the scope is named for and which safe
  // scope's constraints it inherits, so it must be the argument the shell
  // passes: `git \branch --list` runs `git branch --list`, and a scope
  // stored as `git \branch` would inherit nothing of `branch`'s list-only
  // rule while matching `git \branch release`.
  if (first !== undefined && (analysis.expands?.[firstIndex + 1] || /[*?[\]{}~$\\#]/.test(first))) {
    return undefined;
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
