/**
 * The review posture's fixed parts: the operator's rules from config and
 * the small built-in list. Pure functions of the call and the config, so
 * the policy can run them before anything that costs a provider call.
 *
 * The rules catch the obvious cases and nothing more: a script file gets
 * around the pipe-to-shell rule, an encoded address around the metadata
 * one. The reviewer and the shell sandbox are what actually protect, and
 * the approvals guide says so.
 */
import type { ApprovalVerdict, JsonValue, Session, Tool, ToolCall, ToolRisk } from '@stratusagent/core';

import {
  analyzeCommand,
  commandScopeFromPrefix,
  matchesScope,
  type CommandAnalysis,
  type CommandScope,
} from './commands.ts';
import { analyzeCompound } from './compound.ts';
import { normalizeTrustedDomain, originScopeFor, trustedDomainOf } from './origins.ts';

/**
 * One operator rule from `approvals.rules`: a tool, at most one matcher,
 * and the answer. Held in every session, so an operator's `block` always
 * blocks and their `allow` holds even after outside content: it's their
 * standing answer, written in config, not a click.
 */
export interface ReviewRule {
  /** An exact tool name, or a prefix ending in `.*` (`mcp.stripe.*`). */
  tool: string;
  /** Command-scope syntax (`git push`), for a tool that runs a command. */
  command?: string;
  /** An origin (`https://app.example.com`), or `https://*.<domain>` for a domain and its subdomains. */
  origin?: string;
  /** A destination as the tool names it (`slack:C0123`), or `<kind>:*`. */
  destination?: string;
  verdict: ApprovalVerdict;
}

const VERDICTS: readonly string[] = ['allow', 'ask', 'block'];
const RULE_KEYS = new Set(['tool', 'command', 'origin', 'destination', 'verdict']);
const MATCHERS = ['command', 'origin', 'destination'] as const;

/** `mcp.stripe.refund`, or `mcp.stripe.*`. A bare `*` would be a posture, not a rule. */
const TOOL_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\.\*)?$/;

/**
 * The words of a rule that asks or blocks: the base command and the
 * subcommands after it. Looser than an allow scope on purpose, since a
 * rule that refuses `git push` must also refuse `git push --force`.
 */
const commandWords = (raw: string): { scope: CommandScope } | { reason: string } => {
  if (/['"]/.test(raw)) {
    return { reason: 'it contains quotes; write the command as plain words' };
  }
  const analysis = analyzeCommand(raw.trim());
  if (analysis.pipeline) {
    return { reason: 'it is a pipeline; write one command' };
  }
  if (analysis.disqualifiedBy || analysis.base === undefined) {
    return { reason: analysis.disqualifiedBy ?? 'it could not be read as a command' };
  }
  const args = analysis.tokens.slice(1);
  if (args.some((token) => token.startsWith('-'))) {
    return { reason: 'it names a flag; write the command and its subcommands only' };
  }
  return { scope: { command: analysis.base, ...(args.length > 0 ? { args } : {}) } };
};

/** The domain an `https://*.<domain>` origin names, or undefined for any other spelling. */
const wildcardDomain = (origin: string): string | undefined => {
  const match = /^https:\/\/\*\.([^/:]+)$/i.exec(origin.trim());
  return match ? normalizeTrustedDomain(match[1] as string) : undefined;
};

const DESTINATION_PATTERN = /^[a-z][a-z0-9-]*:\S+$/;

/**
 * Reads one rule from config, or says why it can't. Refused rather than
 * dropped, like the rest of `approvals`: a rule an operator wrote and the
 * daemon skipped would leave them believing a block is in place.
 */
export const parseReviewRule = (raw: unknown): { rule: ReviewRule } | { reason: string } => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { reason: 'expected an object like { "tool": "shell.run", "command": "git push", "verdict": "allow" }' };
  }
  const source = raw as Record<string, unknown>;
  const unknownKey = Object.keys(source).find((key) => !RULE_KEYS.has(key));
  if (unknownKey !== undefined) {
    return { reason: `unknown key "${unknownKey}"; a rule has tool, verdict and at most one of command, origin or destination` };
  }
  if (typeof source.tool !== 'string' || source.tool.length === 0) {
    return { reason: 'it needs a tool: an exact name, or a prefix ending in .* (mcp.stripe.*)' };
  }
  if (!TOOL_PATTERN.test(source.tool)) {
    return { reason: `tool "${source.tool}" is neither an exact name nor a prefix ending in .*` };
  }
  if (typeof source.verdict !== 'string' || !VERDICTS.includes(source.verdict)) {
    return { reason: 'it needs a verdict: allow, ask or block' };
  }
  const verdict = source.verdict as ApprovalVerdict;
  const named = MATCHERS.filter((key) => source[key] !== undefined);
  if (named.length > 1) {
    return { reason: `it names ${named.join(' and ')}; a rule takes at most one of command, origin or destination` };
  }
  const rule: ReviewRule = { tool: source.tool, verdict };
  const matcher = named[0];
  if (matcher === undefined) {
    return { rule };
  }
  const value = source[matcher];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { reason: `${matcher} must be a non-empty string` };
  }
  if (matcher === 'command') {
    const scope = verdict === 'allow' ? commandScopeFromPrefix(value) : commandWords(value);
    if ('reason' in scope) {
      return { reason: `command "${value}": ${scope.reason}` };
    }
    return { rule: { ...rule, command: value.trim() } };
  }
  if (matcher === 'origin') {
    // A `*` anywhere but a leading `https://*.` is a typo, not a pattern,
    // even where the URL parser would take it as part of a host name.
    const exact = value.includes('*') ? undefined : originScopeFor(value.trim());
    if (wildcardDomain(value) === undefined && (exact === undefined || exact.origin !== value.trim().replace(/\/$/, ''))) {
      return { reason: `origin "${value}" is not an origin like https://app.example.com or https://*.example.com` };
    }
    return { rule: { ...rule, origin: value.trim().replace(/\/$/, '') } };
  }
  if (!DESTINATION_PATTERN.test(value.trim())) {
    return { reason: `destination "${value}" is not a destination like slack:C0123 or slack:*` };
  }
  return { rule: { ...rule, destination: value.trim() } };
};

/** What a rule is matched against: the call's tool and the one thing its scope hook names. */
export interface ReviewedCall {
  toolName: string;
  command?: string;
  origin?: string;
  destination?: string;
}

const toolMatches = (pattern: string, toolName: string): boolean =>
  pattern.endsWith('.*') ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName;

/** Every command a line runs, or undefined when it can't be split into commands. */
const commandsOf = (command: string): CommandAnalysis[] | undefined => {
  const compound = analyzeCompound(command);
  if (!compound.disqualifiedBy) {
    return compound.pipelines.flat().map((stage) => stage.analysis);
  }
  const single = analyzeCommand(command);
  return single.disqualifiedBy ? undefined : single.pipeline ?? [single];
};

const commandRuleMatches = (rule: ReviewRule, command: string): boolean => {
  if (rule.verdict === 'allow') {
    // All of it, through the same engine as an approved scope, and no
    // redirection: a line that also writes somewhere is more than the rule
    // says yes to.
    const parsed = commandScopeFromPrefix(rule.command as string);
    if ('reason' in parsed) {
      return false;
    }
    const compound = analyzeCompound(command);
    if (compound.disqualifiedBy) {
      return false;
    }
    const stages = compound.pipelines.flat();
    return stages.length > 0
      && stages.every((stage) => stage.redirects.length === 0 && matchesScope(stage.analysis, parsed.scope));
  }
  // Any of it, for a rule that asks or blocks, and the words anywhere in
  // the line as a backstop for one this reader can't split (`bash -c "…"`).
  const words = commandWords(rule.command as string);
  if ('reason' in words) {
    return false;
  }
  const commands = commandsOf(command) ?? [];
  if (commands.some((analysis) => analysis.base === words.scope.command
    && (words.scope.args ?? []).every((arg, index) => analysis.tokens[index + 1] === arg))) {
    return true;
  }
  const sequence = [words.scope.command, ...(words.scope.args ?? [])]
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`(?:^|[\\s;&|("'\`])${sequence}(?=$|[\\s;&|)"'\`])`).test(command);
};

const originRuleMatches = (pattern: string, origin: string): boolean => {
  const domain = wildcardDomain(pattern);
  if (domain !== undefined) {
    return trustedDomainOf(origin, [domain]) !== undefined;
  }
  return originScopeFor(pattern)?.origin === origin;
};

const destinationRuleMatches = (pattern: string, destination: string): boolean =>
  pattern.endsWith(':*')
    ? destination.startsWith(pattern.slice(0, -1)) && destination.length > pattern.length - 1
    : pattern === destination;

/**
 * The first rule that matches this call, or undefined. A rule naming a
 * matcher matches only a call that names that thing: a `command` rule
 * never matches a tool that runs no command.
 */
export const matchReviewRule = (rules: readonly ReviewRule[], call: ReviewedCall): ReviewRule | undefined =>
  rules.find((rule) => {
    if (!toolMatches(rule.tool, call.toolName)) {
      return false;
    }
    if (rule.command !== undefined) {
      return call.command !== undefined && commandRuleMatches(rule, call.command);
    }
    if (rule.origin !== undefined) {
      return call.origin !== undefined && originRuleMatches(rule.origin, call.origin);
    }
    if (rule.destination !== undefined) {
      return call.destination !== undefined && destinationRuleMatches(rule.destination, call.destination);
    }
    return true;
  });

/** How a rule reads in a reason: its tool and matcher, never the call's input. */
export const describeReviewRule = (rule: ReviewRule): string =>
  `${rule.tool}${rule.command !== undefined ? ` command "${rule.command}"` : ''}${rule.origin !== undefined ? ` origin ${rule.origin}` : ''}${rule.destination !== undefined ? ` destination ${rule.destination}` : ''}: ${rule.verdict}`;

/** Which built-in rule settled a call. */
export type BuiltInReviewRuleName = 'metadata-address' | 'sends-secret' | 'pipe-to-shell';

export interface BuiltInReviewHit {
  rule: BuiltInReviewRuleName;
  verdict: 'ask' | 'block';
  /** One line naming the rule, never the value that tripped it. */
  reason: string;
}

/**
 * The whole address or host, with nothing of a longer name on either side:
 * `169.254.169.254.example.com` is somebody else's site.
 */
const METADATA_ADDRESSES = /(?<![A-Za-z0-9.-])(?:169\.254\.169\.254|metadata\.google\.internal)\.?(?![A-Za-z0-9.-])|(?<![0-9A-Fa-f:])fd00:ec2::254(?![0-9A-Fa-f:])/i;

/** Token shapes long enough to be a credential rather than a mention of its prefix. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bxox[abposr]-[0-9A-Za-z-]{10,}/,
  /\bxapp-[0-9A-Za-z-]{10,}/,
  /\bghp_[0-9A-Za-z]{20,}/,
  /\bgithub_pat_[0-9A-Za-z_]{20,}/,
  /\bsk-ant-[0-9A-Za-z_-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

/** A stored value shorter than this is too likely to occur by chance to block on. */
const MIN_SECRET_LENGTH = 8;

/** Programs that reach the network, for a shell command that sends outside. */
const NETWORK_CLIENTS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp',
  'http', 'https', 'xh', 'aria2c', 'gh',
]);

/** What a download may be piped into and run. */
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'perl', 'ruby', 'node', 'bun', 'deno',
]);
const DOWNLOADERS = new Set(['curl', 'wget']);
/**
 * Wrappers that run the program named after their own options, with the
 * options that take a separate value, so `sudo -u root sh` reads as `sh`.
 */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'])],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '--unset', '--chdir'])],
  ['command', new Set<string>()],
  ['exec', new Set(['-a'])],
  ['nohup', new Set<string>()],
  ['nice', new Set(['-n', '--adjustment'])],
  ['time', new Set(['-f', '-o'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['setsid', new Set<string>()],
  ['xargs', new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'])],
]);
/** Wrappers whose first positional is theirs, not the program: `timeout 10 curl`. */
const WRAPPER_POSITIONALS: ReadonlyMap<string, number> = new Map([['timeout', 1]]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const strings = (value: JsonValue | undefined, out: string[] = []): string[] => {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      strings(item, out);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      strings(item, out);
    }
  }
  return out;
};

/**
 * The program a command actually runs: past leading assignments
 * (`MODE=x curl`) and any wrappers with their options and values
 * (`sudo -u root`, `env -i PATH=/bin`, `timeout 10`, `nice -n 5 --`).
 */
const programOf = (analysis: CommandAnalysis): string | undefined => {
  const { tokens } = analysis;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (ASSIGNMENT.test(token)) {
      index += 1;
      continue;
    }
    const name = token.split('/').pop() as string;
    const valued = WRAPPERS.get(name);
    if (valued === undefined) {
      return name;
    }
    index += 1;
    let positionals = WRAPPER_POSITIONALS.get(name) ?? 0;
    while (index < tokens.length) {
      const next = tokens[index] as string;
      if (next === '--') {
        index += 1;
        break;
      }
      if (ASSIGNMENT.test(next)) {
        index += 1;
        continue;
      }
      if (next.startsWith('-')) {
        index += valued.has(next) ? 2 : 1;
        continue;
      }
      if (positionals > 0) {
        positionals -= 1;
        index += 1;
        continue;
      }
      break;
    }
  }
  return undefined;
};

const sendsOutside = (call: { toolName: string; command?: string }): boolean => {
  if (call.toolName === 'message.send' || call.toolName === 'web.fetch'
    || call.toolName.startsWith('browser.') || call.toolName.startsWith('mcp.')) {
    return true;
  }
  if (call.command === undefined) {
    return false;
  }
  const commands = commandsOf(call.command);
  if (commands === undefined) {
    // Unreadable: a client named anywhere counts.
    return [...NETWORK_CLIENTS].some((client) => new RegExp(`(?:^|[\\s;&|(\`'"])${client}(?=$|\\s)`).test(call.command as string));
  }
  return commands.some((analysis) => {
    const program = programOf(analysis);
    return program !== undefined && NETWORK_CLIENTS.has(program);
  });
};

const pipesDownloadIntoInterpreter = (command: string): boolean => {
  const compound = analyzeCompound(command);
  const pipelines = compound.disqualifiedBy
    ? (() => {
        const single = analyzeCommand(command);
        return single.pipeline ? [single.pipeline] : [];
      })()
    : compound.pipelines.map((pipeline) => pipeline.map((stage) => stage.analysis));
  return pipelines.some((pipeline) => {
    const first = pipeline.findIndex((analysis) => DOWNLOADERS.has(programOf(analysis) ?? ''));
    return first >= 0 && pipeline.slice(first + 1).some((analysis) => INTERPRETERS.has(programOf(analysis) ?? ''));
  });
};

/**
 * The built-in rules, in order: a cloud metadata address blocks, a token
 * or stored credential in a call that sends outside blocks, and a
 * download piped into an interpreter asks. `secrets` are the stored
 * credential values the agent can use; one is matched exactly.
 */
export const builtInReviewRule = (
  call: { toolName: string; input: JsonValue; command?: string },
  secrets: readonly string[],
): BuiltInReviewHit | undefined => {
  const values = strings(call.input);
  if (values.some((value) => METADATA_ADDRESSES.test(value))) {
    return {
      rule: 'metadata-address',
      verdict: 'block',
      reason: `${call.toolName} names a cloud metadata address, which the built-in review rules block`,
    };
  }
  if (sendsOutside(call)) {
    const known = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
    if (values.some((value) => TOKEN_SHAPES.some((shape) => shape.test(value)) || known.some((secret) => value.includes(secret)))) {
      return {
        rule: 'sends-secret',
        verdict: 'block',
        reason: `${call.toolName} would send what looks like a credential or token outside, which the built-in review rules block`,
      };
    }
  }
  if (call.command !== undefined && pipesDownloadIntoInterpreter(call.command)) {
    return {
      rule: 'pipe-to-shell',
      verdict: 'ask',
      reason: `${call.toolName} pipes a download into an interpreter, which the built-in review rules ask a person about`,
    };
  }
  return undefined;
};

/**
 * The fixed codes a reviewer's answer is reported under. The reviewer's own
 * line can echo the call's input, so the log and the event carry one of
 * these instead, and the line goes only to the agent and the approver, who
 * are shown the call anyway.
 */
export const REVIEW_CODES = [
  'asked-for',
  'not-asked-for',
  'follows-outside-content',
  'sends-secret',
  'new-destination',
  'unclear',
  'review-failed',
] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];

/** What the review posture needs from the host, per agent and per call. */
export interface ReviewSettings {
  /**
   * The operator's rules for this agent, first match wins: the agent's own
   * before the top-level ones, which is the host's to order.
   */
  rules?: readonly ReviewRule[];
  /**
   * Work the review out for every gated call without acting on it: calls
   * run as they would under `open`, and each decision is reported marked
   * `shadow`, off the call path.
   */
  shadow?: boolean;
  /** How long one review may take before it counts as failed. Default 20 s. */
  timeoutMs?: number;
}

/** One call put to the reviewer. The host builds the case from these. */
export interface ReviewRequest {
  session: Session;
  call: ToolCall;
  tool: Tool;
  risk: ToolRisk;
  /** What the call's scope hook named, when it names one. */
  command?: string;
  origin?: string;
  destination?: string;
  /**
   * Fires when the turn is cancelled or the review runs out of time. A
   * reviewer passes it to its provider call.
   */
  signal: AbortSignal;
}

/** The reviewer's answer. `reason` is one line for the agent and the approver, never logged. */
export interface ReviewAnswer {
  verdict: ApprovalVerdict;
  code: ReviewCode;
  reason: string;
}

export type Reviewer = (request: ReviewRequest) => Promise<ReviewAnswer>;

/**
 * A review that couldn't run, with the kind a person reads in the log
 * (`provider-error`, `budget`, `unparseable`, `unknown-model`). Anything
 * else a reviewer throws is reported as `error`. Either way the call is
 * asked about, never allowed.
 */
export class ReviewFailure extends Error {
  readonly kind: string;

  constructor(kind: string, message?: string) {
    super(message ?? `the review couldn't run: ${kind}`);
    this.name = 'ReviewFailure';
    this.kind = kind;
  }
}

export interface ReviewOptions {
  /** This agent's review settings, read per call, or undefined when it isn't on the review posture. */
  settingsFor(agentId: string): ReviewSettings | undefined;
  /** Asks the reviewer. Omitted, every review fails, so every reviewed call is asked about. */
  reviewer?: Reviewer;
  /**
   * The stored credential values this agent's tools can use, for the
   * built-in rule. Asked only for a call that reaches that rule: a gated
   * call in a conversation that has read outside content.
   */
  secretsFor?(agentId: string): readonly string[] | Promise<readonly string[]>;
}

const REVIEW_REASON_LIMIT = 300;

/**
 * The reviewer's answer if it has the right shape, with an unknown code
 * read as `unclear` and the reason cut to one bounded line; undefined when
 * the verdict or the reason is missing, which counts as a failed review.
 */
export const readReviewAnswer = (raw: unknown): ReviewAnswer | undefined => {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.verdict !== 'string' || !VERDICTS.includes(source.verdict)) {
    return undefined;
  }
  if (typeof source.reason !== 'string' || source.reason.trim().length === 0) {
    return undefined;
  }
  const line = source.reason.trim().split(/\r?\n/)[0] as string;
  const code = typeof source.code === 'string' && (REVIEW_CODES as readonly string[]).includes(source.code) && source.code !== 'review-failed'
    ? source.code as ReviewCode
    : 'unclear';
  return {
    verdict: source.verdict as ApprovalVerdict,
    code,
    reason: line.length > REVIEW_REASON_LIMIT ? `${line.slice(0, REVIEW_REASON_LIMIT)}…` : line,
  };
};
