import type {
  AlwaysMeans,
  ApprovalAnswer,
  ApprovalContext,
  ApprovalOutcome,
  ApprovalPolicy,
  ApprovalRefusal,
  ApprovalVerdict,
  JsonObject,
  JsonValue,
  Session,
  Tool,
  ToolCall,
  ToolRisk,
} from '@stratusagent/core';
import { sessionTaintedBy, sessionTrustOf } from '@stratusagent/core';

/**
 * Re-exported, not re-implemented: the risk ordering moved to the kernel
 * when the plugin loader became its second consumer, and this package
 * published the name first.
 */
export { atLeastAsRisky } from '@stratusagent/core';

import { downloadInsideWorkspace, gitInsideWorkspace, gitPushInsideWorkspace, readsInsideWorkspace } from './workspace.ts';
import {
  builtInReviewRule,
  describeReviewRule,
  matchReviewRule,
  readReviewAnswer,
  ReviewFailure,
  type ReviewCode,
  type ReviewOptions,
} from './review.ts';

export {
  builtInReviewRule,
  describeReviewRule,
  matchReviewRule,
  parseReviewRule,
  readReviewAnswer,
  REVIEW_CODES,
  ReviewFailure,
  type BuiltInReviewHit,
  type BuiltInReviewRuleName,
  type ReviewAnswer,
  type ReviewCode,
  type ReviewedCall,
  type Reviewer,
  type ReviewOptions,
  type ReviewRequest,
  type ReviewRule,
  type ReviewSettings,
} from './review.ts';

export { downloadInsideWorkspace, gitInsideWorkspace, gitPushInsideWorkspace, readsInsideWorkspace } from './workspace.ts';
import {
  analyzeCommand,
  describeCommandScope,
  findCoveringScopes,
  findMatchingScope,
  normalizeCommandScope,
  SAFE_COMMAND_SCOPES,
  type CommandAnalysis,
  type CommandScope,
} from './commands.ts';
import {
  describeOriginScope,
  findMatchingOriginScope,
  originScopeFor,
  trustedDomainOf,
  type OriginScope,
} from './origins.ts';
import {
  describeToolGrant,
  findMatchingToolGrant,
  type ToolGrant,
} from './grants.ts';
import {
  describeDestinationGrant,
  findMatchingDestinationGrant,
  type DestinationGrant,
} from './destinations.ts';
import {
  analyzeCompound,
  compoundCommandNames,
  grantableByName,
  judgeCompound,
  NOT_GRANTABLE_BY_NAME,
  type CommandNameGrant,
  type CompoundJudgement,
} from './compound.ts';
import {
  WhitelistUnreadableError,
  type CommandNameStore,
  type CommandWhitelistStore,
  type DestinationWhitelistStore,
  type OriginWhitelistStore,
  type ToolGrantStore,
} from './whitelist.ts';

export {
  analyzeCommand,
  commandScopeFromPrefix,
  describeCommandScope,
  findCoveringScopes,
  findMatchingScope,
  matchesScope,
  normalizeCommandScope,
  NUMERIC_FLAG,
  parseCommandScope,
  sameScope,
  SAFE_COMMAND_SCOPES,
  type CommandAnalysis,
  type CommandScope,
} from './commands.ts';
export {
  describeOriginScope,
  findMatchingOriginScope,
  matchesOriginScope,
  originScopeFor,
  parseOriginScope,
  sameOriginScope,
  normalizeTrustedDomain,
  SHARED_SUFFIXES,
  trustedDomainProblem,
  trustedDomainOf,
  type OriginScope,
} from './origins.ts';
export {
  describeToolGrant,
  findMatchingToolGrant,
  matchesToolGrant,
  parseToolGrant,
  sameToolGrant,
  type ToolGrant,
} from './grants.ts';
export {
  describeDestinationGrant,
  findMatchingDestinationGrant,
  matchesDestinationGrant,
  parseDestinationGrant,
  sameDestinationGrant,
  type DestinationGrant,
} from './destinations.ts';
export {
  createFileCommandWhitelist,
  describeAgentGrants,
  whitelistPathFor,
  LEGACY_WHITELIST_SUFFIX,
  legacyWhitelistPathFor,
  resolveWhitelistPath,
  WhitelistUnreadableError,
  type AgentGrants,
  type AgentGrantsListing,
  type AgentGrantStore,
  type CommandNameStore,
  type CommandWhitelistStore,
  type DestinationWhitelistStore,
  type OriginWhitelistStore,
  type ToolGrantStore,
} from './whitelist.ts';
export {
  analyzeCompound,
  GRANTABLE_BY_NAME,
  grantableByName,
  judgeCompound,
  NOT_GRANTABLE_BY_NAME,
  parseCommandNameGrant,
  SUBCOMMAND_COMMANDS,
  type CommandNameGrant,
  type CompoundCommand,
  type CompoundCoverage,
  type CompoundJudgement,
  type CompoundStage,
  type Redirect,
} from './compound.ts';

/**
 * How a policy reaches a human — or admits that it cannot.
 *
 * - `interactive` — there is a terminal. Ask, and remember the answer for
 *   the rest of the session.
 * - `headless` — nobody is reachable. Safe calls run, everything else is
 *   refused and the refusal is reported, because a daemon that silently
 *   drops half a turn is worse than one that says what it would not do.
 * - `remote` — nobody is at a terminal, but somebody is reachable through
 *   a channel. The turn parks on a request published elsewhere and resumes
 *   on the answer.
 *
 * `remote` needs a `request` transport for the same reason `interactive`
 * needs `ask`: this package decides *whether* a human is required and what
 * their answer means, and never how to reach one. Delivery is the
 * gateway's (a bus event) and the channel's (Slack buttons).
 */
export type PermissionMode = 'interactive' | 'headless' | 'remote';

/**
 * One gated call, handed to whatever can reach a person. Deliberately the
 * same shape the kernel hands the policy — a transport that had to
 * reconstruct the call from a name would be guessing at exactly the
 * details an approver is being asked about.
 */
export interface ApprovalRequest {
  session: Session;
  call: ToolCall;
  tool: Tool;
  risk: ToolRisk;
  /**
   * The origin this call would act on, for a tool judged by one
   * (`Tool.originFor`). A transport MUST show it: the call's own arguments
   * do not say where a click lands, so offering **Always allow** beside
   * `browser.act` and a CSS selector would be asking somebody to widen a
   * site they were never shown.
   */
  origin?: string;
  /**
   * True when answering `always` runs this call once and remembers
   * nothing — a `dangerous` tool, which asks every time whatever is
   * clicked, or a call judged by origin whose conversation has no page to
   * grant. A transport MUST NOT offer an unconditional "always" for one of
   * these: a button promising a standing grant that the engine will not
   * create is the same defect as a record understating one it did.
   *
   * Absent is the ordinary case, where `always` remembers *something* —
   * and `always` below says what.
   */
  oneShot?: boolean;
  /**
   * What `always` would remember, when it would remember something. The
   * other half of `oneShot`: that one says a grant will not be created,
   * this one says which kind will — so a transport can tell an approver in
   * advance whether they are widening this session or this agent, and
   * report afterwards what was actually granted rather than hedging
   * between lifetimes it could not distinguish. Absent exactly when
   * `oneShot` is true.
   */
  always?: AlwaysMeans;
  /**
   * When this call first parked, if it is being re-asked after a restart.
   * A transport that imposes a deadline measures from here rather than
   * granting a fresh window.
   */
  parkedAt?: string;
  /**
   * Why the review posture is asking, in one line: the reviewer's own words
   * or the rule that asked. A transport shows it beside the call, since it
   * is what the approver is being asked to second-guess.
   */
  reviewNote?: string;
  /**
   * The turn's abort signal. A transport MUST invalidate its outstanding
   * request when this fires: the answer would otherwise arrive for a turn
   * that no longer exists, and acting on it would run a tool for cancelled
   * work.
   */
  signal?: AbortSignal;
}

/**
 * Publishes a request and settles when a human answers it — or when
 * whatever is carrying it gives up. It never rejects for a timeout: an
 * expired request is a `deny`, which is a decision the turn can continue
 * from, not an error that fails it.
 *
 * A transport that knows who answered settles with an `ApprovalOutcome`
 * so a standing grant can record them; one that does not settles with the
 * bare answer, and both mean the same thing to the policy.
 */
export type ApprovalRequester = (request: ApprovalRequest) => Promise<ApprovalAnswer | ApprovalOutcome>;

/**
 * Which check made a decision, so a person reading a refusal knows which
 * setting to change instead of guessing from the wording.
 *
 * - `risk`: the tool's risk alone, a `safe` tool or a `gated` one under
 *   `approvals.posture` open, or a `dangerous` one nobody could approve.
 * - `scope`: a command scope, approved or built-in safe, covered the
 *   command, or none did.
 * - `parse`: the command couldn't be reduced to a scope at all.
 * - `autonomy`: workspace autonomy.
 * - `grant`: a standing grant (tool, site, trusted domain, destination,
 *   channel authorization, the schedule's destination, or this session's
 *   "always"), or none covered the call.
 * - `gate`: `approvals.externalContent` "gate" set the grants aside.
 * - `approver`: a person answered.
 * - `cancelled`: the turn was cancelled before or during the wait.
 * - `rule`: under the review posture, an operator rule from
 *   `approvals.rules` or a built-in review rule.
 * - `review`: under the review posture, the reviewer, or a review that
 *   couldn't run.
 *
 * A refusal with nobody to ask names the check that failed to cover the
 * call, not `approver`, because that's the one the operator can change.
 */
export type DecisionLayer =
  | 'risk'
  | 'scope'
  | 'parse'
  | 'autonomy'
  | 'grant'
  | 'gate'
  | 'approver'
  | 'cancelled'
  | 'rule'
  | 'review';

/** Why a call was allowed or refused, for logs and events. */
export interface PermissionDecision {
  allowed: boolean;
  mode: PermissionMode;
  risk: ToolRisk;
  toolName: string;
  sessionId: string;
  agentId: string;
  /**
   * The call this decision was about, so a surface can put the decision
   * beside it. Optional so a decision from an older emitter still
   * type-checks; this policy always sets it.
   */
  callId?: string;
  /**
   * One line, written for a person reading a daemon log at 3am — and
   * deliberately free of the tool's input.
   *
   * The daemon log is a trace, not a second transcript: it records that a
   * tool ran, never what it was called with. A refusal that quoted the
   * command would put an agent-composed string — a URL, a token somebody
   * pasted into a prompt — into a file this project documents as safe to
   * read and to share. What the reason names instead is the *scope*: the
   * base command and its subcommand, which is the actionable half and is a
   * classification rather than the arguments.
   */
  reason: string;
  /**
   * The command this decision was about, for a surface that is showing a
   * person the thing they are approving — a Slack prompt, a live console.
   * Carried separately precisely so it is not in `reason`, and a consumer
   * that logs it is making that choice knowingly.
   */
  command?: string;
  /**
   * The outbound destination this decision was about, for a tool that
   * carries one (`Tool.destinationFor`). Unlike `command` it also appears
   * in `reason`: a channel id is a classification, like a command scope's
   * base-plus-subcommand, not agent-composed text.
   */
  destination?: string;
  /**
   * The origin this decision was about, for a tool judged by one
   * (`Tool.originFor`). In `reason` too, on the same test `destination`
   * passes: an origin is scheme, host, and port with no path, query, or
   * fragment, so it is a classification of where a call landed rather than
   * agent-composed text — which is the whole reason the scope is drawn at
   * the origin and not at a URL.
   */
  origin?: string;
  /**
   * The standing grant this call ran under, when one did. The daemon logs
   * it: a call that ran because an operator once said "always" for this
   * agent is exactly what someone reconstructing an unattended run needs
   * to tell apart from one that ran because the tool was `safe`, and
   * `reason` alone is prose. Absent on every other decision, including
   * the one that created the grant — that one ran on a human's answer.
   */
  grant?: ToolGrant;
  /**
   * The per-conversation grant this call ran under, when one did
   * (`message.read`/`message.send` on a destination an approver answered
   * "always" for). Logged by the daemon for the same reason as `grant`.
   */
  destinationGrant?: DestinationGrant;
  /**
   * Which check made this decision. Optional so a decision from an older
   * emitter still type-checks; this policy always sets it.
   */
  layer?: DecisionLayer;
  /** Under the review posture: what the rule or the reviewer answered, when one did. */
  verdict?: ApprovalVerdict;
  /** Under the review posture: the reviewer's answer as a fixed code, never its words. */
  reviewCode?: ReviewCode;
  /** True for a decision worked out without acting on it (`approvals.review.shadow`). */
  shadow?: boolean;
}

export interface PermissionPolicyOptions {
  mode: PermissionMode;
  /**
   * Asks the human. Required for `interactive`; the returned string is read
   * leniently, since it comes from someone typing at a prompt.
   */
  ask?: (question: string) => Promise<string>;
  /** Reaches the human through a channel. Required for `remote`. */
  request?: ApprovalRequester;
  /**
   * Called for every decision, allowed or not. The daemon routes this to
   * its log: an unattended refusal that appears nowhere is indistinguishable
   * from an agent that chose not to act.
   */
  onDecision?: (decision: PermissionDecision) => void;
  /**
   * The command-scope engine, for tools that carry a command string
   * (`Tool.commandFor`). Omitted, every gated call needs a human however
   * innocuous its arguments — which is the honest behaviour for a daemon
   * with no scope list, and an unusable one for a shell.
   */
  commands?: CommandScopeOptions;
  /**
   * The destination-scope check, for tools that carry one
   * (`Tool.destinationFor`). Omitted, every gated send needs a human —
   * which is exactly the pre-carve-out behaviour, so a policy built
   * without it loses nothing but the schedule feature.
   */
  destinations?: DestinationScopeOptions;
  /**
   * The origin-scope engine, for tools that name one (`Tool.originFor`).
   * Omitted, a browser action still cannot receive a tool-wide grant — that
   * exclusion is structural and lives on the hook, not here — so a policy
   * built without this asks every time, which is the honest behaviour for a
   * host with nowhere to keep a grant.
   */
  origins?: OriginScopeOptions;
  /**
   * The standing-grant engine, for a gated tool that names no scope at
   * all (no `commandFor`, `destinationFor`, or `originFor`). Omitted, an
   * "always" on such a tool still holds for this process, per agent — the
   * same bargain a policy with no whitelist store makes — and nothing
   * survives a restart, which is what a host with nowhere to keep a grant
   * is honestly offering.
   */
  grants?: ToolGrantOptions;
  /**
   * Whether an agent's grants stop applying once its conversation has read
   * `external` content — a web page, a search result, an MCP server's
   * reply. Asked per call with the agent's id, so a host can answer from
   * per-agent config without rebuilding the policy. Omitted, or answering
   * false, a session's label changes nothing here, which is the
   * label-only behaviour provenance shipped with.
   *
   * When it answers true for a session that has read such content, every
   * grant a person made somewhere else stops counting for it: standing tool
   * grants, command scopes, site grants, "always this session". What still
   * runs unattended is what never rested on a grant — `safe` tools, the
   * built-in safe command scopes — and a schedule's pre-authorized
   * destination (`destinations`), which a person chose for this exact job.
   * Everything else asks, and `headless` refuses.
   */
  gateExternalContent?: (agentId: string) => boolean;
  /**
   * Whether this agent's gated calls run without asking: the operator's
   * `approvals.posture: "open"`, read per call like the gate above. A
   * `dangerous` call still asks, and a conversation the gate above has
   * closed (it read external content with `gate` on) goes back to the
   * scope-and-grant path. Omitted, or answering false, nothing changes.
   */
  openFor?: (agentId: string) => boolean;
  /**
   * The review posture (`approvals.posture: "review"`): for an agent whose
   * `settingsFor` answers, a gated call is settled by the operator's
   * rules, then runs unreviewed if the conversation has read nothing from
   * outside, then by the built-in rules, then by what the external-content
   * gate leaves alone, and otherwise by the reviewer. Every ask it makes is
   * one-shot. Omitted, or answering undefined, nothing changes.
   */
  review?: ReviewOptions;
}

export interface ToolGrantOptions {
  /** Where "always allow" persists a tool grant, and where one is read back. */
  store?: ToolGrantStore;
  /**
   * Which plugin package contributes a tool right now, or undefined for
   * a kernel tool. Recorded on the grant when it is made and compared
   * when it is used, so a grant follows the tool the operator was shown
   * and not a later tool of the same name (`grants.ts` says why). Omitted,
   * every tool reads as the kernel's, which matches every grant recorded
   * the same way — the honest answer for a host with no plugin loader.
   */
  contributorOf?: (toolName: string) => string | undefined;
  /**
   * Called when a grant is persisted, for the same reason the scope
   * engines report theirs: this is the decision that widens what runs
   * unattended for every future session.
   */
  onGranted?: (event: { agentId: string; grant: ToolGrant }) => void;
}

export interface DestinationScopeOptions {
  /**
   * Whether this session may speak to this destination unattended.
   *
   * This is the schedule carve-out and deliberately nothing wider: the
   * expected implementation first checks that the session is a firing the
   * scheduler itself started and still has in flight — metadata alone
   * proves nothing, since dispatch callers can write it — then loads the
   * row a human approved and answers by comparing destinations. So the
   * grant is a single (schedule, destination) pair, minted by an
   * approval, revoked the moment `schedule.cancel` deletes the row.
   * Consulted per call, never cached here: a schedule cancelled mid-turn
   * must gate the very next send.
   */
  isPreauthorized(session: Session, destination: string): boolean | Promise<boolean>;
  /**
   * Where "always allow" on a call judged by destination persists, and
   * where one is read back: one conversation, one tool, for this agent,
   * until revoked (`destinations.ts`). Omitted, the answer holds for this
   * process only, like every other grant with nowhere to go.
   */
  whitelist?: DestinationWhitelistStore;
  /**
   * The workspace the agent's channel is connected to right now, for the
   * channel the destination names (the Slack team id for `slack:C…`), or
   * undefined when there is none or it is not connected. A destination
   * grant records it and matches only under the same one, because a
   * conversation id is unique only within its workspace. Asked per call,
   * so an app that moved workspaces stops matching its old grants on the
   * next call.
   */
  accountFor?(agentId: string, destination: string): string | undefined | Promise<string | undefined>;
  /** Called when a destination grant is persisted, for the daemon's log. */
  onGranted?: (event: { agentId: string; grant: DestinationGrant }) => void;
  /**
   * The operator's standing channel authorization for this agent
   * (`approvals.channels`): destinations where `message.read` and
   * `message.send` run without asking: `channel:<workspace>/<id>`
   * (`slack:T0123ABCD/C0123ABCD`), `channel:<workspace>/*`, or `channel:*`
   * for every channel of that kind the agent's app can reach. Read per
   * call. See `matchesStandingChannel`.
   */
  standingChannelsFor?(agentId: string): readonly string[];
  /**
   * What kind of conversation a destination is, asked of the agent's own
   * channel app: `channel` for a public or private channel, `direct` for a
   * DM or group DM. Undefined when the channel cannot say (not connected,
   * not visible to the app, a lookup that failed). The standing channel
   * authorization covers `channel` only, so a DM, and anything unknown,
   * still asks.
   */
  conversationKindFor?(agentId: string, destination: string): ConversationKind | undefined | Promise<ConversationKind | undefined>;
}

/** See `DestinationScopeOptions.conversationKindFor`. */
export type ConversationKind = 'channel' | 'direct';

/**
 * The tools an operator's standing channel authorization covers. Kernel
 * tools only: a plugin tool registered under the same name is a different
 * tool and is judged the usual way.
 */
export const STANDING_CHANNEL_TOOLS: readonly string[] = ['message.read', 'message.send'];

/**
 * Whether a configured `approvals.channels` entry covers a destination in
 * the workspace the agent's app is connected to right now (`account`, see
 * `DestinationScopeOptions.accountFor`):
 *
 * - `channel:*`: every conversation of that kind the app can reach, in
 *   whatever workspace it is in.
 * - `channel:<workspace>/<id>`: that conversation, only while the app is in
 *   that workspace. A conversation id is unique only within its workspace,
 *   so an id is bound to one, the same way an Always-allow grant is.
 * - `channel:<workspace>/*`: every conversation of that kind in that
 *   workspace.
 *
 * A bare `channel:<id>` names no workspace and covers nothing; the daemon
 * says so at startup (`unboundStandingChannels`). The kind check (channels
 * yes, DMs no) is the caller's.
 */
export const matchesStandingChannel = (
  destination: string,
  account: string | undefined,
  entries: readonly string[],
): boolean => {
  const separator = destination.indexOf(':');
  if (separator <= 0 || separator === destination.length - 1) {
    return false;
  }
  const kind = destination.slice(0, separator);
  const to = destination.slice(separator + 1);
  return entries.some((entry) => {
    if (entry === `${kind}:*`) {
      return true;
    }
    if (!entry.startsWith(`${kind}:`) || account === undefined || account.length === 0) {
      return false;
    }
    const scoped = entry.slice(kind.length + 1);
    const slash = scoped.indexOf('/');
    if (slash <= 0) {
      return false;
    }
    const workspace = scoped.slice(0, slash);
    const id = scoped.slice(slash + 1);
    return workspace === account && (id === '*' || id === to);
  });
};

/** Entries that name a conversation without its workspace, which `matchesStandingChannel` never matches. */
export const unboundStandingChannels = (entries: readonly string[]): string[] =>
  entries.filter((entry) => {
    const separator = entry.indexOf(':');
    const rest = entry.slice(separator + 1);
    return separator > 0 && rest !== '*' && !rest.includes('/');
  });

export interface CommandScopeOptions {
  /**
   * Scopes that run unattended. Defaults to `SAFE_COMMAND_SCOPES`; pass a
   * list to replace it, or spread it to extend.
   */
  safeScopes?: readonly CommandScope[];
  /** Where "always allow" persists a scope, and where one is read back. */
  whitelist?: CommandWhitelistStore;
  /**
   * Where "always allow" persists a grant on a command by name (`grep`),
   * and where one is read back. Omitted, such a grant lasts for this
   * process. Only used with `grantRootFor`, since a by-name grant means
   * nothing without a workspace to keep it in.
   */
  names?: CommandNameStore;
  /**
   * The agent's workspace, whether or not autonomy is on for it: where a
   * by-name grant may point, where a compound command may redirect output,
   * and where `cat`, `head`, `tail` and `ls` read without asking. Undefined
   * for an agent turns all of that off, and "always" stores the narrower
   * scope it did before.
   */
  grantRootFor?(agentId: string): string | undefined;
  /**
   * Workspace autonomy. Answers the directory an agent may read in without
   * asking, or undefined when autonomy is off for it. With an answer, a
   * command (or pipeline stage) that only reads, and only inside that
   * directory, runs unattended; see `workspace.ts`. Needs the tool's
   * `cwdFor`, since relative paths mean nothing without it.
   */
  workspace?: {
    directoryFor(agentId: string): string | undefined;
    /**
     * Branch-name prefixes the agent may push without asking. Defaults to
     * `<agentId>/`. An empty list means pushing always asks.
     */
    branchPrefixesFor?(agentId: string): readonly string[] | undefined;
  };
  /**
   * Called when a scope is persisted. The daemon logs it: an approval that
   * widens what runs unattended, for every future session, is exactly the
   * decision that must not be the one leaving no trace.
   */
  onScopeRemembered?: (event: { agentId: string; scope: CommandScope }) => void;
  /** Called when a command is granted by name, for the same reason. */
  onCommandNameRemembered?: (event: { agentId: string; grant: CommandNameGrant }) => void;
}

export interface OriginScopeOptions {
  /**
   * Where "always allow" persists an origin, and where one is read back.
   * Omitted, an origin grant lasts for this process only — which is what
   * `headless` cannot use, since it never asks anyone in the first place.
   *
   * There is no `safeOrigins` beside this on purpose: `CommandScopeOptions`
   * can default to a built-in safe list because `git status` is read-only
   * wherever it runs, and no origin has that property. See `origins.ts`.
   */
  whitelist?: OriginWhitelistStore;
  /** Called when an origin is persisted, for the same reason as above. */
  onScopeRemembered?: (event: { agentId: string; scope: OriginScope }) => void;
  /**
   * Domains the operator trusts this agent to read from without asking:
   * `openai.com` covers it and its subdomains, over https. Applies to the
   * read-only origin tools (`trustedDomainTools`) and, under workspace
   * autonomy, to plain `curl` downloads into the workspace. Never
   * to a tool that acts on a site (`browser.act`), and withdrawn, like
   * every grant, from a conversation the external-content gate has closed.
   * Read per call, so the answer is always the config's.
   */
  trustedDomainsFor?: (agentId: string) => readonly string[];
  /** The origin tools that only read. Default `['web.fetch']`. */
  trustedDomainTools?: readonly string[];
}

/** The tool whose origin grants also cover a plain download of that site. */
const READ_ORIGIN_TOOL = 'web.fetch';

const YES = new Set(['y', 'yes', 'always', 'a']);
const ALWAYS = new Set(['always', 'a']);

const ABORTED = Symbol('aborted');

/** How long one review may take before it counts as failed (`approvals.review.timeoutMs`). */
export const DEFAULT_REVIEW_TIMEOUT_MS = 20_000;

/**
 * Waits for `work`, but gives up the moment the turn is cancelled.
 *
 * Checking `signal.aborted` on either side of an await is not the same
 * thing: the await in the middle is exactly where a cancelled turn gets
 * stuck, because the human it is waiting on may answer late or never — a
 * closed terminal, a transport that dropped. Abandoning the wait leaves
 * the prompt outstanding, so its eventual settlement is swallowed rather
 * than surfacing as an unhandled rejection against a turn that is gone.
 */
const untilAborted = async <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> => {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    work.catch(() => undefined);
    return ABORTED;
  }

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof ABORTED>((resolve) => {
        onAbort = (): void => resolve(ABORTED);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
};

/**
 * The key an in-session "always allow" is remembered under. Per tool and
 * per session, never per call: remembering the exact call would make the
 * answer useless on the next one, and remembering it fleet-wide would make
 * one impatient yes permanent.
 *
 * Since standing and destination grants landed this tier serves one
 * narrow shape: a tool judged by destination whose input named none the
 * tool could parse, so there is no conversation to grant. A durable tool
 * grant there would be a standing yes to every destination, so the session
 * is the widest honest lifetime.
 *
 * Joined on an escaped NUL rather than a space or a colon, because both of
 * those occur in real ids — a channel session id is
 * `slack:ava:T01ABCDEF:C07GHIJKL:…` — and a separator that can appear in
 * either half makes two different pairs collide on one key. Written as
 * `\u0000` and never as the byte itself: a raw NUL makes git classify the
 * whole file as binary, which hides every future diff of it.
 */
const sessionKey = (sessionId: string, toolName: string): string => `${sessionId}\u0000${toolName}`;

/**
 * How long any single string value may be before it is elided, and the
 * overall backstop for an argument object with an unusual number of fields.
 */
const PROMPT_VALUE_LIMIT = 120;
const PROMPT_OVERALL_LIMIT = 400;

/**
 * Cap every string in a value to `PROMPT_VALUE_LIMIT`, structure preserved.
 *
 * The point is *per field*, not overall: a schedule's free-form `prompt`
 * must not be able to push its `destination` past a length cut and hide the
 * one thing the operator most needs to see — where an approved schedule may
 * post. Bounding each string instead keeps every key visible, so a long
 * prompt shortens itself and leaves the cadence and destination intact.
 */
const capStrings = (value: JsonValue): JsonValue => {
  if (typeof value === 'string') {
    return value.length > PROMPT_VALUE_LIMIT ? `${value.slice(0, PROMPT_VALUE_LIMIT)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map(capStrings);
  }
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = capStrings(nested);
    }
    return out;
  }
  return value;
};

/**
 * A one-line rendering of a gated call's arguments for a terminal prompt,
 * or undefined when there are none. Bounded — an approver reads it inline,
 * not a scrollback of JSON — and never a decision input: what this returns
 * is shown to a human, never matched against a scope. Long values are
 * capped individually (see `capStrings`) so no single field can hide the
 * rest; the overall cap is only a backstop for an object with many fields.
 *
 * When even the per-field-capped rendering overflows, the cut is **not
 * silent**: it ends with an explicit marker, so an approver is never shown
 * a partial argument set that reads as complete — a field trimmed off the
 * tail (a schedule's `destination`, say) must announce itself as hidden,
 * the same warning the Slack prompt already renders. An honest prompt is
 * the security property here; the realistic few-field call never truncates.
 */
const summarizeInput = (input: JsonObject): string | undefined => {
  if (Object.keys(input).length === 0) {
    return undefined;
  }
  const oneLine = JSON.stringify(capStrings(input));
  return oneLine.length > PROMPT_OVERALL_LIMIT
    ? `${oneLine.slice(0, PROMPT_OVERALL_LIMIT)}… [arguments truncated — inspect the call before approving]`
    : oneLine;
};

/**
 * Puts the question to someone at a terminal. A prompt's answer is free
 * text from a person mid-typing, so it is read leniently and anything that
 * is not recognisably a yes is a no.
 */
const awaitPrompt = async (
  context: ApprovalContext,
  ask: NonNullable<PermissionPolicyOptions['ask']>,
  command: string | undefined,
  origin: string | undefined,
  /**
   * What answering "always" will actually do, decided by the caller — which
   * is the only place that knows. Offering a lifetime the engine will not
   * create is the same defect as hiding one it will.
   */
  alwaysMeans: string,
  /** Why the review posture is asking, shown above the question. */
  note?: string,
): Promise<ApprovalOutcome | typeof ABORTED> => {
  const { call, risk, session } = context;
  // The command, when there is one: for a shell call the tool name is the
  // least interesting half of the question, and an approver shown only
  // `shell.run (gated)` is being asked to trust something they cannot see.
  // The same is true of any gated call that carries arguments — approving
  // `schedule.every` sets up recurring unattended work and (with a
  // destination) a standing permission to speak, so the operator must see
  // the cadence, prompt, and destination, not just the tool name. When
  // there is no command scope to show, fall back to a compact rendering of
  // the call's input, exactly as the remote (Slack) prompt already does.
  const argumentSummary = command === undefined ? summarizeInput(call.input) : undefined;
  // The origin goes in front of the arguments rather than into them: a
  // selector says nothing about where a click lands, and this is the half
  // of the question "always" widens.
  const acting = origin === undefined ? call.toolName : `${call.toolName} on ${origin}`;
  const what = command !== undefined
    ? `${call.toolName}: ${command}`
    : argumentSummary !== undefined
      ? `${acting} (${risk}): ${argumentSummary}`
      : `${acting} (${risk})`;
  const pending = ask(
    `${note === undefined ? '' : `Review: ${note}\n`}Allow ${what} for ${session.agent.name}? [y]es / [a]lways (${alwaysMeans}) / [N]o: `,
  );
  // The answer is never read after this point if the turn ends first,
  // so a late yes cannot execute a tool for work that no longer exists.
  pending.catch(() => undefined);

  const response = await untilAborted(pending, context.signal);
  if (response === ABORTED) {
    return ABORTED;
  }

  const answer = response.trim().toLowerCase();
  if (!YES.has(answer)) {
    return { answer: 'deny' };
  }
  return { answer: ALWAYS.has(answer) ? 'always' : 'once' };
};

/**
 * Puts the question to someone reachable through a channel. Unlike the
 * prompt, the answer arrives already typed — a button carries one of three
 * values — so there is nothing to interpret; the work is entirely in not
 * outliving the turn.
 *
 * A transport that rejects (its channel is down, the request could not be
 * delivered) denies rather than failing the turn: the agent should be told
 * its call was not approved and carry on, not crash on the machinery that
 * was supposed to ask.
 */
const awaitRemote = async (
  context: ApprovalContext,
  request: ApprovalRequester,
  origin: string | undefined,
  oneShot: boolean,
  always: AlwaysMeans | undefined,
  note?: string,
): Promise<ApprovalOutcome | typeof ABORTED> => {
  const pending = request({
    session: context.session,
    call: context.call,
    tool: context.tool,
    risk: context.risk,
    ...(origin !== undefined ? { origin } : {}),
    ...(oneShot ? { oneShot } : {}),
    ...(always !== undefined ? { always } : {}),
    ...(context.parkedAt ? { parkedAt: context.parkedAt } : {}),
    ...(note !== undefined ? { reviewNote: note } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  }).then(
    (outcome): ApprovalOutcome => (typeof outcome === 'string' ? { answer: outcome } : outcome),
    (): ApprovalOutcome => ({ answer: 'deny' }),
  );

  return untilAborted(pending, context.signal);
};

/**
 * The kernel's ApprovalPolicy, deciding by the tool's declared risk and —
 * for a tool that carries one — by the command an invocation would run.
 * `safe` runs unattended; anything else needs a human unless a scope covers
 * it, and whether a human exists at all is what `mode` answers.
 *
 * The three tiers resolve in order: scopes granted "always" in this session,
 * then the agent's persistent whitelist, then the built-in safe list —
 * after which there is nothing left but asking. A `dangerous` tool skips
 * the scope engine entirely: its risk is a statement about the tool, and no
 * argument shape makes `rm -rf` a read.
 *
 * A tool that names an *origin* (`Tool.originFor`) resolves through the
 * same two grant tiers over a different vocabulary — the site the page is
 * on, rather than the command the call would run. It has no third tier,
 * because there is no origin that is safe to click on out of the box.
 *
 * A gated tool that names no scope at all resolves through a *standing
 * grant*: the tool itself, per agent, durable until revoked, over the same
 * two tiers again (this process, then the file). It is what "always allow"
 * creates for such a tool on every surface, so one word has one lifetime —
 * and it is the only path a scope-less gated tool has to running in
 * `headless`, which is the mode every installed service runs in.
 */
/**
 * What a log line may say an invocation runs: its base command, never its
 * arguments, which is what keeps a refusal out of the transcript business.
 */
const commandNames = (analysis: CommandAnalysis | undefined): string | undefined => {
  if (!analysis) {
    return undefined;
  }
  if (analysis.pipeline) {
    // Not the stage names: the first is the agent's own choice, but the
    // rest of a pipeline is where a composed command puts the part a page
    // talked it into, and the log is a trace rather than a transcript.
    return 'a pipeline';
  }
  return analysis.base;
};

/** What this policy answers: a yes, or a refusal carrying the reason it logged. */
type Verdict = true | ApprovalRefusal;

export const createPermissionPolicy = (options: PermissionPolicyOptions): ApprovalPolicy => {
  const { mode, ask, request, onDecision, commands, destinations, origins, grants, gateExternalContent, openFor, review } = options;
  if (mode === 'interactive' && !ask) {
    throw new Error('interactive permission mode needs an `ask` function to reach a human.');
  }
  // Same reason as `ask`, and the more important half: a remote policy with
  // nothing to publish through would park every gated call on a request no
  // one ever sees, which reads as a hung agent rather than a refusal.
  if (mode === 'remote' && !request) {
    throw new Error('remote permission mode needs a `request` function to reach a human.');
  }

  const alwaysAllowed = new Set<string>();
  // Tier one of the three: scopes granted with "always" during this
  // process's life, for a policy that has nowhere else to put them. A
  // policy built with no whitelist store still has to remember an answer
  // for the rest of the session, which is what `always` means at a
  // terminal; so does one whose store refused the write. A grant the store
  // *took* is not kept here as well: the store is then the one place a
  // grant lives, so revoking it there is the next call's answer, rather
  // than a promise the daemon keeps only until its next restart.
  const sessionScopes = new Map<string, CommandScope[]>();
  /** The same tier for commands granted by name. */
  const sessionNames = new Map<string, CommandNameGrant[]>();
  /** The same tier for origins, and for the same reason. */
  const sessionOrigins = new Map<string, OriginScope[]>();
  /** And for standing tool grants. */
  const processGrants = new Map<string, ToolGrant[]>();
  /** And for destination grants. */
  const processDestinations = new Map<string, DestinationGrant[]>();
  const rememberForProcess = <T>(tier: Map<string, T[]>, agentId: string, grant: T): void => {
    tier.set(agentId, [...(tier.get(agentId) ?? []), grant]);
  };
  /**
   * The review posture's bookkeeping, keyed by the call's context so the
   * many `report` sites need no new arguments: which contexts are a shadow
   * review (decisions marked `shadow`, nobody asked), and what a rule or
   * the reviewer answered for a call that went on to a person.
   */
  const shadowContexts = new WeakSet<ApprovalContext>();
  const reviewNotes = new WeakMap<ApprovalContext, { verdict: ApprovalVerdict; reviewCode?: ReviewCode }>();

  /** A site this agent may read without asking: trusted, or approved for `web.fetch`. */
  const readableSite = async (agentId: string, site: string): Promise<boolean> => {
    if (trustedDomainOf(site, origins?.trustedDomainsFor?.(agentId) ?? []) !== undefined) {
      return true;
    }
    const granted = [
      ...(sessionOrigins.get(agentId) ?? []),
      ...(origins?.whitelist ? await origins.whitelist.originsFor(agentId) : []),
    ];
    return findMatchingOriginScope(site, granted, READ_ORIGIN_TOOL) !== undefined;
  };

  const report = (
    context: ApprovalContext,
    layer: DecisionLayer,
    allowed: boolean,
    reason: string,
    command?: string,
    destination?: string,
    origin?: string,
    grant?: ToolGrant,
    destinationGrant?: DestinationGrant,
  ): Verdict => {
    const note = reviewNotes.get(context);
    const shadow = shadowContexts.has(context);
    const reviewed = {
      ...(note === undefined ? {} : { verdict: note.verdict }),
      ...(note?.reviewCode === undefined ? {} : { reviewCode: note.reviewCode }),
      ...(shadow ? { shadow: true } : {}),
    };
    onDecision?.({
      allowed,
      mode,
      risk: context.risk,
      toolName: context.call.toolName,
      sessionId: context.session.id,
      agentId: context.session.agent.id,
      callId: context.call.id,
      reason,
      ...(command === undefined ? {} : { command }),
      ...(destination === undefined ? {} : { destination }),
      ...(origin === undefined ? {} : { origin }),
      ...(grant === undefined ? {} : { grant }),
      ...(destinationGrant === undefined ? {} : { destinationGrant }),
      layer,
      ...reviewed,
    });
    // The same three fields the log gets, and nothing else: the runner's
    // event carries no command, grant or destination record, so what a
    // dashboard shows is a classification, never the call's input. The
    // review fields are a verdict and a fixed code, never the reviewer's
    // words.
    context.decided?.({ allowed, layer, reason, ...reviewed });
    // The reason is what the agent is told: it names the check that
    // refused and what would cover the call, which is what lets the agent
    // pick another way instead of trying the same call again.
    return allowed ? true : { allowed: false, reason };
  };

  /**
   * A refusal whose words for the agent differ from the log's: the
   * reviewer's line can echo the call's input, so it goes to the agent
   * (and, for an ask, the approver) and never into a decision.
   */
  const refuse = (context: ApprovalContext, layer: DecisionLayer, reason: string, told: string): Verdict => {
    report(context, layer, false, reason);
    return { allowed: false, reason: told };
  };

  /**
   * Why the review posture sends a call to a person: the check that asked,
   * the line the log gets, and the line the agent and the approver get.
   */
  interface ReviewAsk {
    layer: DecisionLayer;
    /** For the log and the event: no input. */
    reason: string;
    /** For the agent, if nobody can be asked. */
    told: string;
    /** For the approver, beside the call. */
    note: string;
  }

  /**
   * Puts one call to the reviewer, bounded by `timeoutMs` and the turn's
   * signal. Never throws: a review that couldn't run is a failure kind,
   * which the caller turns into an ask.
   */
  const runReview = async (
    context: ApprovalContext,
    timeoutMs: number,
    resolved: { command?: string; origin?: string; destination?: string },
  ): Promise<{ answer: ReturnType<typeof readReviewAnswer> & object } | { failed: string } | typeof ABORTED> => {
    if (context.signal?.aborted) {
      return ABORTED;
    }
    const reviewer = review?.reviewer;
    if (reviewer === undefined) {
      return { failed: 'no reviewer' };
    }
    const controller = new AbortController();
    const onTurnAbort = (): void => controller.abort();
    context.signal?.addEventListener('abort', onTurnAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ failed: string }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ failed: 'timeout' });
      }, timeoutMs);
    });
    try {
      // Inside a promise, so a reviewer that throws before it returns one
      // is a failed review like any other, never a failed turn.
      const asked = new Promise<unknown>((resolve) => {
        resolve(reviewer({
          session: context.session,
          call: context.call,
          tool: context.tool,
          risk: context.risk,
          ...resolved,
          signal: controller.signal,
        }));
      }).then(
        (raw) => {
          const answer = readReviewAnswer(raw);
          return answer === undefined ? { failed: 'unparseable' } : { answer };
        },
        (error: unknown) => ({ failed: error instanceof ReviewFailure ? error.kind : 'error' }),
      );
      const settled = await untilAborted(Promise.race([asked, timedOut]), context.signal);
      return settled;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onTurnAbort);
    }
  };

  const policy: ApprovalPolicy = {
    async approve(context: ApprovalContext): Promise<Verdict> {
      const { call, risk, session } = context;

      if (risk === 'safe') {
        return report(context, 'risk', true, `${call.toolName} is safe and runs without approval`);
      }

      // The review posture, for a gated call. A shadow review is this same
      // method run again on a marked copy of the context, off the call
      // path: it works the review out and asks nobody.
      const reviewSettings = risk === 'gated' ? review?.settingsFor(session.agent.id) : undefined;
      const shadowRun = shadowContexts.has(context);
      const reviewing = reviewSettings !== undefined && (shadowRun || reviewSettings.shadow !== true);
      if (reviewSettings?.shadow === true && !shadowRun && context.parkedAt === undefined) {
        const shadowContext: ApprovalContext = { ...context };
        shadowContexts.add(shadowContext);
        void policy.approve(shadowContext).catch(() => undefined);
      }

      if (risk === 'gated' && !reviewing && (openFor?.(session.agent.id) === true || reviewSettings?.shadow === true)) {
        const closedByContent = sessionTrustOf(session) === 'external' && gateExternalContent?.(session.agent.id) === true;
        if (!closedByContent) {
          return report(
            context,
            'risk',
            true,
            reviewSettings?.shadow === true
              ? `${call.toolName} runs without asking (approvals.review.shadow: reviewed off the call path, not enforced)`
              : `${call.toolName} runs without asking (approvals.posture is open)`,
          );
        }
      }

      // Steps 3 to 5 of the review, before any grant is read: the
      // operator's rules, the unreviewed run for a conversation that has
      // read nothing from outside, and the built-in rules. An ask from any
      // of them goes to a person and skips everything a grant could cover,
      // since the first step that settles a call wins.
      let reviewAsk: ReviewAsk | undefined;
      const reviewHooks = [context.tool.commandFor, context.tool.destinationFor, context.tool.originFor]
        .filter((hook) => hook !== undefined).length;
      const reviewed = reviewing && reviewHooks <= 1
        ? {
            command: context.tool.commandFor?.(call.input),
            destination: context.tool.destinationFor?.(call.input),
            origin: originScopeFor(context.tool.originFor?.(session, call.input) ?? '')?.origin,
          }
        : {};
      const resolvedForReview = Object.fromEntries(
        Object.entries(reviewed).filter(([, value]) => value !== undefined),
      ) as { command?: string; origin?: string; destination?: string };
      // A call parked before a restart was waiting on a person, and goes
      // back to one: nothing that would allow it now (a rule, the
      // unreviewed path, a scope, the reviewer) may turn a pending ask into
      // an allow. Only a block can still stop it first.
      const resumed = reviewing && context.parkedAt !== undefined;
      if (reviewing) {
        const matched = matchReviewRule(reviewSettings.rules ?? [], { toolName: call.toolName, ...resolvedForReview });
        if (matched !== undefined) {
          reviewNotes.set(context, { verdict: matched.verdict });
          const named = `the operator's rule (${describeReviewRule(matched)}) in approvals.rules`;
          if (matched.verdict === 'allow' && !resumed) {
            return report(context, 'rule', true, `${call.toolName} runs under ${named}`);
          }
          if (matched.verdict === 'block') {
            return report(
              context,
              'rule',
              false,
              `${call.toolName} is blocked by ${named}; only the operator can change it, so a confirmation won't help`,
            );
          }
          if (matched.verdict === 'ask') {
            reviewAsk = {
              layer: 'rule',
              reason: `${call.toolName} is asked about by ${named}`,
              told: `${call.toolName} is asked about by ${named}`,
              note: `asked about by the operator's rule (${describeReviewRule(matched)})`,
            };
          }
        }
        if (reviewAsk === undefined && !resumed && sessionTrustOf(session) !== 'external') {
          return report(context, 'risk', true, `${call.toolName} not reviewed: this conversation has read nothing from outside`);
        }
        // The stored values, for the rule against sending one out. A store
        // that can't be read asks, like any other part of the review that
        // couldn't run: never a failed turn, never an allow.
        let secrets: readonly string[] | undefined;
        if (reviewAsk === undefined) {
          try {
            secrets = (await review?.secretsFor?.(session.agent.id)) ?? [];
          } catch {
            reviewNotes.set(context, { verdict: 'ask', reviewCode: 'review-failed' });
            const reason = `${call.toolName} needs a person's yes because the review couldn't run: secrets-unreadable`;
            reviewAsk = { layer: 'review', reason, told: reason, note: 'the review couldn\'t run: secrets-unreadable' };
          }
        }
        if (reviewAsk === undefined && secrets !== undefined) {
          const hit = builtInReviewRule(
            { toolName: call.toolName, input: call.input, ...(resolvedForReview.command === undefined ? {} : { command: resolvedForReview.command }) },
            secrets,
          );
          if (hit !== undefined) {
            reviewNotes.set(context, { verdict: hit.verdict });
            if (hit.verdict === 'block') {
              return report(context, 'rule', false, `${hit.reason}; only the operator can change that (approvals.rules)`);
            }
            reviewAsk = { layer: 'rule', reason: hit.reason, told: hit.reason, note: hit.reason };
          }
        }
        if (reviewAsk === undefined && resumed) {
          reviewNotes.set(context, { verdict: 'ask' });
          const reason = `${call.toolName} was waiting for a person before a restart, and goes back to them without another review`;
          reviewAsk = { layer: 'review', reason, told: reason, note: 'waiting for you before a restart; not reviewed again' };
        }
      }
      // Nothing a grant or a scope could cover applies to a call a review
      // rule already sent to a person.
      const grantsConsidered = reviewAsk === undefined;

      // What this *invocation* would run, for a tool whose danger lives in
      // its arguments. Resolved before anything else so that the tool-wide
      // "always" below can never apply to it: one yes to `git status` must
      // not become a standing yes to every command the shell can run.
      // A tool that offers more than one scope hook is judged by none of
      // them, and asks like any other gated call.
      //
      // Each hook narrows a call along one axis — what it runs, where it
      // sends, what site it acts on — and each grant answers only its own
      // question. Composing them needs a decision nobody has made: a call
      // with two axes could reasonably need every applicable scope to
      // authorize it, or the narrowest, and picking silently is how a
      // grant on one axis waves through a call unapproved on the other.
      // Falling back to a human is the answer that cannot be wrong while
      // that decision is unmade.
      //
      // Nothing offers two today (`shell.run` a command, `message.send` a
      // destination, `browser.act` an origin), so this changes nothing now
      // — it is here so that adding one cannot quietly open that door. The
      // guard first covered only `commandFor`, and left exactly this hole
      // for `destinationFor`; one rule over all three has no such corner.
      const scopeHooks = [
        context.tool.commandFor,
        context.tool.destinationFor,
        context.tool.originFor,
      ].filter((hook) => hook !== undefined).length;
      const singlyScoped = scopeHooks <= 1;
      // Turning the scope engines off is only half of it. The tool-wide
      // "always" is what a tool with no scope at all falls back to, and
      // letting a multi-hook tool reach it would be worse than the hole
      // this rule closed: one yes, and then a session of unattended calls
      // with neither scope consulted. A tool that asked to be judged by a
      // scope does not get to be judged by nothing instead.
      const multiplyScoped = scopeHooks > 1;
      // No scope hook at all: the tool's risk lives in its identity, which
      // is the one shape a grant on the whole tool is honest for. This is
      // what makes the `commandFor` / `originFor` exclusion structural —
      // a tool that offers a scope is never `unscoped`, so it can never
      // reach the standing grant below, whatever a refactor does to the
      // order of the checks after this line.
      const unscoped = scopeHooks === 0;
      // Who contributes this tool right now, for matching a grant and for
      // recording one. Resolved once so both halves see the same answer.
      const contributor = grants?.contributorOf?.(call.toolName);
      // Whether this conversation has read text an outsider wrote, and the
      // operator asked for that to cost it its grants. A grant is a person's
      // answer to a question about calls the *agent* would choose; once a
      // web page can be choosing them, the answer was given to a different
      // question. The label is monotonic and written at execution, before
      // the next call is judged, so a call the page asked for is never the
      // one that slips through ahead of its own taint.
      //
      // `external` only. `unknown` is what a shell's output carries, and a
      // gate on it would take the grants from every coding agent on its
      // first command — a rule that fires on every session is one an
      // operator turns off, and then it guards nothing. A stranger's
      // message, the other common `unknown`, is what `principals.admit`
      // exists to refuse before the turn starts.
      // The review posture includes the gate: after outside content, a
      // grant answered a question about calls the agent chose, not calls a
      // page might be choosing.
      const externalGate = sessionTrustOf(session) === 'external'
        && (gateExternalContent?.(session.agent.id) === true || reviewing);

      /**
       * Workspace autonomy for one command in one directory: a read inside
       * it, local git, a plain download from a readable site, or a push of
       * the agent's own branch. Shared by the single-command path and the
       * compound one, so the two cannot drift.
       */
      const autonomousStage = async (stage: CommandAnalysis, cwd: string, workspace: string): Promise<boolean> => {
        if (await readsInsideWorkspace(stage, cwd, workspace)) {
          return true;
        }
        // Local git changes things, so it's a grant like any other
        // to a conversation the external-content gate has closed.
        if (!externalGate && await gitInsideWorkspace(stage, cwd, workspace)) {
          return true;
        }
        // A plain download from a site the agent may already read:
        // a trusted domain, or one approved for `web.fetch`. Granted
        // trust, so not to a conversation the gate has closed.
        // And not for an agent the gate is on for at all: the shell
        // marks its output `unknown`, not `external`, so a page read
        // this way would never close the gate it exists to close.
        const gated = gateExternalContent?.(session.agent.id) === true || reviewing;
        const site = gated ? undefined : await downloadInsideWorkspace(stage, cwd, workspace);
        if (site !== undefined && await readableSite(session.agent.id, site)) {
          return true;
        }
        const prefixes = commands?.workspace?.branchPrefixesFor?.(session.agent.id) ?? [`${session.agent.id}/`];
        return !externalGate && await gitPushInsideWorkspace(stage, cwd, workspace, prefixes);
      };

      const command = risk === 'gated' && singlyScoped
        ? context.tool.commandFor?.(call.input)
        : undefined;
      const analysis = command === undefined ? undefined : analyzeCommand(command);

      // Whether this tool is judged by *where* it acts, and where it is
      // acting right now. `gated` only, for the reason a destination cannot
      // launder a `dangerous` call either: a scope narrows a tool whose
      // risk lives in its arguments, and `dangerous` is a statement about
      // the tool itself.
      //
      // The two are separate on purpose. `scopedByOrigin` is true for any
      // tool that offers the hook, even on a call where it answers nothing
      // — a page that has not loaded, one closed by the idle sweep — and it
      // is what bars the tool-wide "always" below. Without that, a click
      // approved on a page whose origin could not be named would fall back
      // to a standing yes to `browser.act` on every site, which is exactly
      // the grant per-origin scopes exist to replace.
      const scopedByOrigin = risk === 'gated'
        && singlyScoped
        && context.tool.originFor !== undefined;
      // The grants first, and where the page is *after* them. Read the
      // other way round, the store's disk read sits between the two, and a
      // page that redirects inside it has a grant for site A allow a click
      // on site B — the same shape as the approval wait below, with a
      // shorter gap and no bound on it at all when the store is somebody
      // else's. There is no await between this read and the match, so the
      // origin a grant is checked against is where the conversation is when
      // the decision is made, not where it was.
      const grantedOrigins = scopedByOrigin && !externalGate
        ? [
            ...(sessionOrigins.get(session.agent.id) ?? []),
            ...(origins?.whitelist ? await origins.whitelist.originsFor(session.agent.id) : []),
          ]
        : [];
      const reportedOrigin = scopedByOrigin ? context.tool.originFor?.(session, call.input) : undefined;
      // Read through the same normalizer a grant file is read through,
      // rather than taken as written. The hook's contract is an origin, but
      // this is what a grant is compared against — a plugin that hands back
      // a whole page URL should get a grant on its origin, not one that
      // silently never matches anything.
      const originScope = reportedOrigin === undefined ? undefined : originScopeFor(reportedOrigin);
      const origin = originScope?.origin;
      // Where a tool judged by destination is reading or sending, for a
      // standing grant on that one conversation. Undefined when the input
      // names none the tool can parse; such a call asks, and "always"
      // falls back to this session, as every destination call did before.
      const destination = risk === 'gated' && singlyScoped
        ? context.tool.destinationFor?.(call.input)
        : undefined;

      // The agent's workspace for by-name grants and compound commands, and
      // how a compound reading of this command was judged. Kept for the
      // question below: what "always" would grant depends on which of its
      // commands nothing covered.
      const grantRoot = analysis ? commands?.grantRootFor?.(session.agent.id) : undefined;
      let judgement: CompoundJudgement | undefined;
      if (analysis && grantsConsidered) {
        if (!analysis.disqualifiedBy) {
          // The built-in safe scopes survive the gate and granted ones do
          // not: `git status` was judged safe for any caller, while a
          // granted `git push` was judged for an agent nobody else was
          // steering.
          const granted = externalGate
            ? []
            : [
                ...(sessionScopes.get(session.agent.id) ?? []),
                ...(commands?.whitelist ? await commands.whitelist.scopesFor(session.agent.id) : []),
              ];
          const candidates = [
            ...granted,
            ...(commands?.safeScopes ?? SAFE_COMMAND_SCOPES),
          ];
          // One scope per command of a pipeline, so `git log | grep fix`
          // runs because both halves would on their own, and is named that way.
          const covering = findCoveringScopes(analysis, candidates);
          if (covering) {
            return report(
              context,
              'scope',
              true,
              covering.length === 1
                ? `${call.toolName} ran inside the approved scope "${describeCommandScope(covering[0] as CommandScope)}"`
                : `${call.toolName} ran a pipeline inside the approved scopes ${covering.map((scope) => `"${describeCommandScope(scope)}"`).join(' | ')}`,
              command,
            );
          }
          // Workspace autonomy, for reads. Each stage is covered by a scope
          // or only reads inside the workspace. Not a grant somebody made in
          // another conversation, so it survives the external-content gate:
          // reading its own files can't send anything anywhere, and every
          // stage that could is still judged by scopes, which the gate
          // already emptied.
          const workspace = commands?.workspace?.directoryFor(session.agent.id);
          const cwd = workspace === undefined ? undefined : context.tool.cwdFor?.(session);
          if (workspace !== undefined && cwd !== undefined) {
            const stages = analysis.pipeline ?? [analysis];
            // Only the built-in safe scopes compose with an autonomous
            // stage. A granted scope was judged as a command on its own:
            // `curl https://example.com` approved once must not become the
            // far end of `cat secret | curl … --data-binary @-`.
            // The built-in list itself, not a host's extension of it, which
            // can hold any command a config named.
            const intrinsic = SAFE_COMMAND_SCOPES;
            let read = false;
            let covered = true;
            for (const stage of stages) {
              if (findMatchingScope(stage, intrinsic)) {
                continue;
              }
              if (await autonomousStage(stage, cwd, workspace)) {
                read = true;
                continue;
              }
              covered = false;
              break;
            }
            if (covered && read) {
              return report(
                context,
                'autonomy',
                true,
                `${call.toolName} worked inside ${session.agent.id}'s workspace (autonomy: workspace)`,
                command,
              );
            }
          }
        }
        // A compound reading: a chain, redirections, a command granted by
        // name. Every command must run on its own terms; see `compound.ts`.
        const compound = analyzeCompound(command as string);
        if (!compound.disqualifiedBy) {
          const intrinsic = commands?.safeScopes === undefined
            ? SAFE_COMMAND_SCOPES
            : commands.safeScopes.filter((scope) => SAFE_COMMAND_SCOPES.includes(scope));
          // A host's additions to the safe list survive the gate, as they do
          // above, but compose like a grant: alone, or among scopes.
          const hostScopes = (commands?.safeScopes ?? []).filter((scope) => !SAFE_COMMAND_SCOPES.includes(scope));
          const autonomy = commands?.workspace?.directoryFor(session.agent.id);
          judgement = await judgeCompound(compound, {
            cwd: context.tool.cwdFor?.(session),
            root: grantRoot,
            safeScopes: intrinsic,
            scopes: [
              ...(externalGate
                ? []
                : [
                    ...(sessionScopes.get(session.agent.id) ?? []),
                    ...(commands?.whitelist ? await commands.whitelist.scopesFor(session.agent.id) : []),
                  ]),
              ...hostScopes,
            ],
            // Granted, so withdrawn by the gate like any other grant.
            names: externalGate || grantRoot === undefined
              ? []
              : [
                  ...(sessionNames.get(session.agent.id) ?? []),
                  ...(commands?.names ? await commands.names.commandNamesFor(session.agent.id) : []),
                ].map((grant) => grant.command),
            ...(autonomy !== undefined
              ? { autonomous: (stage: CommandAnalysis, cwd: string) => autonomousStage(stage, cwd, autonomy) }
              : {}),
            reads: readsInsideWorkspace,
          });
          if (judgement.covered) {
            const names = compoundCommandNames(compound.pipelines.flat());
            return report(
              context,
              judgement.coveredBy,
              true,
              `${call.toolName} ran ${names.join(', ')}, each inside what ${session.agent.id} may run unattended`,
              command,
            );
          }
        } else if (analysis.disqualifiedBy && mode === 'headless' && !reviewing) {
          // Never auto-approved, whatever the base command is: a safe scope
          // in front of a backgrounding `&` is the exact shape this rule
          // exists for.
          return report(
            context,
            'parse',
            false,
            `${call.toolName} cannot run unattended: ${analysis.disqualifiedBy}`,
            command,
          );
        }
      } else if (risk === 'gated' && unscoped && !externalGate && grantsConsidered) {
        // The standing grant: this process's answers first, then the file.
        // Read per call, never cached here, so a revocation through the
        // store is the next call's answer — the reason a revoke needs no
        // restart.
        const standing = findMatchingToolGrant(call.toolName, contributor, [
          ...(processGrants.get(session.agent.id) ?? []),
          ...(grants?.store ? await grants.store.toolGrantsFor(session.agent.id) : []),
        ]);
        if (standing) {
          return report(
            context,
            'grant',
            true,
            `${call.toolName} ran under a standing grant for ${session.agent.id}`,
            undefined,
            undefined,
            undefined,
            standing,
          );
        }
      } else if (risk !== 'dangerous'
        && !externalGate
        && grantsConsidered
        && !scopedByOrigin
        && !multiplyScoped
        && alwaysAllowed.has(sessionKey(session.id, call.toolName))) {
        return report(context, 'grant', true, `${call.toolName} was approved for the rest of this session`);
      }

      // Which workspace this destination is in right now, for binding a
      // grant to it (see `DestinationScopeOptions.accountFor`).
      const account = destination !== undefined
        ? await destinations?.accountFor?.(session.agent.id, destination)
        : undefined;
      if (destination !== undefined && !externalGate && grantsConsidered) {
        // Read per call, never cached here, so a revoke is the next call's answer.
        const standing = findMatchingDestinationGrant(call.toolName, destination, account, contributor, [
          ...(processDestinations.get(session.agent.id) ?? []),
          ...(destinations?.whitelist ? await destinations.whitelist.destinationsFor(session.agent.id) : []),
        ]);
        if (standing) {
          return report(
            context,
            'grant',
            true,
            `${call.toolName} to ${destination} ran under a standing grant for ${session.agent.id}`,
            undefined,
            destination,
            undefined,
            undefined,
            standing,
          );
        }
      }

      // The operator's standing channel authorization (`approvals.channels`):
      // a read or a post in a channel the config names runs without asking,
      // in every session, interactive, scheduled, or delegated. Only a
      // conversation the agent's own app reports as a channel: a DM or group
      // DM, or one it cannot describe, falls through and asks as before.
      // Membership and scopes are still the channel's to enforce when the
      // tool runs. Withdrawn by the external-content gate like every other
      // standing yes, so a page the conversation read cannot steer a post.
      if (destination !== undefined
        && !externalGate
        && grantsConsidered
        && contributor === undefined
        && context.tool.name === call.toolName
        && STANDING_CHANNEL_TOOLS.includes(call.toolName)
        && matchesStandingChannel(destination, account, destinations?.standingChannelsFor?.(session.agent.id) ?? [])
        && await destinations?.conversationKindFor?.(session.agent.id, destination) === 'channel') {
        return report(
          context,
          'grant',
          true,
          `${call.toolName} to ${destination} ran under the operator's standing channel authorization (approvals.channels)`,
          undefined,
          destination,
        );
      }

      if (origin !== undefined && grantsConsidered) {
        const granted = findMatchingOriginScope(origin, grantedOrigins, call.toolName);
        if (granted) {
          return report(
            context,
            'grant',
            true,
            `${call.toolName} acted on the approved site ${describeOriginScope(granted)}`,
            undefined,
            undefined,
            origin,
          );
        }
        const trusted = !externalGate && (origins?.trustedDomainTools ?? [READ_ORIGIN_TOOL]).includes(call.toolName)
          ? trustedDomainOf(origin, origins?.trustedDomainsFor?.(session.agent.id) ?? [])
          : undefined;
        if (trusted !== undefined) {
          return report(
            context,
            'grant',
            true,
            `${call.toolName} read from ${origin}, under the trusted domain ${trusted}`,
            undefined,
            undefined,
            origin,
          );
        }
      }

      // The schedule's destination scope, checked before the headless
      // refusal because an unattended firing is exactly when it applies.
      // `gated` only: a destination cannot launder a `dangerous` call, the
      // same way no argument shape makes `rm -rf` a read.
      //
      // Not withdrawn by the external-content gate, and that is the one
      // grant it spares on purpose. A schedule that reads the web and
      // reports to a channel is the job such a schedule is approved for,
      // so withdrawing it would refuse every firing; and what the page can
      // steer is only the words, sent to the one place a person picked.
      if (risk === 'gated' && singlyScoped && destinations && grantsConsidered) {
        const destination = context.tool.destinationFor?.(call.input);
        if (destination !== undefined
          && await destinations.isPreauthorized(session, destination)) {
          return report(
            context,
            'grant',
            true,
            `${call.toolName} to ${destination} was pre-authorized when this schedule was approved`,
            undefined,
            destination,
          );
        }
      }

      // Step 7: nothing above settled it, so the reviewer does. (A resumed
      // call never gets here: it was sent back to its person above.)
      if (reviewing && reviewAsk === undefined) {
        const outcome = await runReview(context, reviewSettings.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS, resolvedForReview);
        if (outcome === ABORTED) {
          return report(context, 'cancelled', false, `${call.toolName} was cancelled while it was being reviewed`);
        }
        if ('failed' in outcome) {
          reviewNotes.set(context, { verdict: 'ask', reviewCode: 'review-failed' });
          const reason = `${call.toolName} needs a person's yes because the review couldn't run: ${outcome.failed}`;
          reviewAsk = { layer: 'review', reason, told: reason, note: `the review couldn't run: ${outcome.failed}` };
        } else {
          const { answer } = outcome;
          reviewNotes.set(context, { verdict: answer.verdict, reviewCode: answer.code });
          if (answer.verdict === 'allow') {
            // The review took time, and a page can move in it: a yes given
            // for one site must not land a click on another. Same rule as
            // a person's yes (`allowUnlessMoved`).
            if (context.tool.originFor !== undefined && reviewHooks <= 1) {
              const settled = originScopeFor(context.tool.originFor(session, call.input) ?? '')?.origin;
              if (settled !== resolvedForReview.origin) {
                return report(
                  context,
                  'review',
                  false,
                  `${call.toolName} was allowed by the reviewer on ${resolvedForReview.origin ?? 'a page with no origin'}, `
                    + `but the conversation is on ${settled ?? 'no page'} now — it did not run`,
                );
              }
            }
            return report(context, 'review', true, `${call.toolName} was allowed by the reviewer (${answer.code})`);
          }
          if (answer.verdict === 'block') {
            // No flag the agent can set to escalate: an injected page could
            // tell it to set one. The person's confirmation in their next
            // message is part of what the reviewer sees next time.
            return refuse(
              context,
              'review',
              `${call.toolName} was blocked by the reviewer (${answer.code})`,
              `${call.toolName} was blocked: ${answer.reason.replace(/[.\s]+$/, '')}. If the person you're working for really wants this, tell them what it would do and ask them to confirm.`,
            );
          }
          reviewAsk = {
            layer: 'review',
            reason: `${call.toolName} was asked about by the reviewer (${answer.code})`,
            told: `${call.toolName} needs a person's yes: ${answer.reason.replace(/[.\s]+$/, '')}`,
            note: answer.reason,
          };
        }
      }

      // A shadow review stops here: it reports what it would have asked,
      // and asks nobody.
      if (shadowRun) {
        return report(
          context,
          reviewAsk?.layer ?? 'review',
          false,
          `${reviewAsk?.reason ?? `${call.toolName} would need a person`} (would ask)`,
        );
      }

      if (mode === 'headless' && reviewAsk !== undefined) {
        return refuse(
          context,
          reviewAsk.layer,
          `${reviewAsk.reason}; nobody is set up to approve this`,
          `${reviewAsk.told}; nobody is set up to approve this`,
        );
      }

      if (mode === 'headless') {
        return report(
          context,
          // A `dangerous` tool before the gate: no grant covers one either
          // way, so naming the gate would send the operator to a setting
          // that changes nothing.
          risk === 'dangerous'
            ? 'risk'
            : externalGate
              ? 'gate'
              : command !== undefined
                ? 'scope'
                : 'grant',
          false,
          // The gate named first otherwise, because it is the cause: the
          // operator reading this has grants on file that look like they
          // should have covered the call, and needs to be told why they did
          // not. The source is a tool name or `sender`, never content.
          risk === 'dangerous'
            ? `${call.toolName} is dangerous and nobody is available to approve it`
            : externalGate
              ? `${call.toolName} was called after this conversation read external content`
                + ` (from ${sessionTaintedBy(session) ?? 'an unrecorded source'}); with approvals.externalContent`
                + ' set to "gate" no grant covers it, and nobody is available to approve it'
              : command !== undefined
                ? `${call.toolName} was called outside every approved scope`
                  + `${commandNames(analysis) ? ` (${commandNames(analysis)})` : ''} and nobody is available to approve it`
                : origin !== undefined
                  // Named, because it is the actionable half: an operator
                  // reading this at 3am needs to know which site to grant, and
                  // an origin carries no path or query to leak while saying so.
                  ? `${call.toolName} was called on ${origin}, which no approved site covers,`
                    + ' and nobody is available to approve it'
                  : scopedByOrigin
                    ? `${call.toolName} was called on a page with no origin a grant could name,`
                      + ' and nobody is available to approve it'
                    : `${call.toolName} is ${risk} and nobody is available to approve it`,
          command,
          undefined,
          origin,
        );
      }

      // An aborted turn must not sit on a prompt: the human would be
      // answering for work that no longer exists, and an answer arriving
      // after the abort would be applied to nothing.
      if (context.signal?.aborted) {
        return report(context, 'cancelled', false, `${call.toolName} was cancelled before it could be approved`);
      }

      // Both remaining modes wait on a person; only the way of reaching one
      // differs. Everything after the wait — what `always` means, how a
      // refusal is reported — is deliberately shared, so a decision made in
      // Slack and one typed at a terminal cannot drift into meaning
      // different things.
      // Whether answering "always" would remember anything at all, decided
      // here because this is where the answer is: a `dangerous` tool never
      // remembers, and an origin-scoped call with no page has nothing to
      // remember. Both are certain before anyone is asked, so both surfaces
      // can stop offering a grant the engine will not create.
      // A command this parser cannot reduce to a scope — a pipe, a
      // subshell, an unbalanced quote, a refspec delete — is the third
      // one-shot shape, and the oldest: the branch below has always run it
      // once and remembered nothing, because widening to the bare tool
      // would hand the agent every command. Resolved here rather than
      // after the answer so the question can say so; it is a pure function
      // of the analysis, and the branch below reuses this exact value.
      const commandScope = analysis ? normalizeCommandScope(analysis) : undefined;
      // With a workspace to hold them, "always" grants what this line was
      // missing instead: each command nothing covered, by name where that
      // is safe (`grep`) and as the narrower scope where it is not (`git
      // push`). Nothing, when one of them cannot be granted either way or
      // what blocked the line was not a command — output sent outside the
      // workspace, a directory this reader could not follow — since a grant
      // that would not make the line run is not one to offer.
      const plan = ((): { names: string[]; scopes: CommandScope[] } | undefined => {
        if (judgement === undefined || grantRoot === undefined || judgement.unfixable || judgement.uncovered.length === 0) {
          return undefined;
        }
        const names: string[] = [];
        const scopes: CommandScope[] = [];
        // A command alone keeps the narrower scope it always could (`python3
        // scripts/check.py`). In a line with others, a shell, interpreter or
        // wrapper gets nothing: `… | sh` is the shape a grant must not learn.
        const alone = analyzeCompound(command as string).pipelines.flat().length === 1;
        for (const stage of judgement.uncovered) {
          const base = stage.analysis.base;
          if (base !== undefined && grantableByName(base)) {
            names.push(base);
            continue;
          }
          if (!alone && base !== undefined && NOT_GRANTABLE_BY_NAME.has(base)) {
            return undefined;
          }
          const scope = normalizeCommandScope(stage.analysis);
          if (scope === undefined) {
            return undefined;
          }
          scopes.push(scope);
        }
        return { names: [...new Set(names)], scopes };
      })();
      const usePlan = judgement !== undefined && grantRoot !== undefined;
      // A gated conversation cannot mint a grant either: the request in
      // front of the approver was composed after a page had its say, and
      // "always" there would let the page talk a person into exactly the
      // standing authority the gate withdrew.
      // And under the review posture every ask is one-shot: an "always"
      // there would promise a grant the policy then sets aside.
      const oneShot = risk === 'dangerous'
        || reviewing
        || externalGate
        || multiplyScoped
        || (scopedByOrigin && origin === undefined)
        || (analysis !== undefined && (usePlan ? plan === undefined : commandScope === undefined));
      // Which kind of grant `always` creates, as data for the transport and
      // as words for the prompt — the same decision, made once, so the two
      // surfaces cannot promise different lifetimes for the same answer.
      const always: AlwaysMeans | undefined = oneShot
        ? undefined
        : command !== undefined
          ? 'scope'
          : scopedByOrigin
            ? 'origin'
            : unscoped
              ? 'tool'
              : destination !== undefined
                ? 'destination'
                : 'session';
      const alwaysMeans = oneShot
        ? risk === 'dangerous'
          ? 'not remembered — a dangerous tool asks every time'
          : reviewing
            ? 'not remembered — under the review posture an answer covers this call only'
          : externalGate
            ? 'not remembered — this conversation has read external content, so it asks every time'
            : multiplyScoped
              ? 'not remembered — this tool names more than one kind of scope'
              : analysis !== undefined
                ? 'not remembered — this command cannot be reduced to a scope'
                : 'not remembered — there is no page to grant'
        : always === 'scope'
          ? usePlan && plan !== undefined
            ? `always ${[...plan.names, ...plan.scopes.map(describeCommandScope)].join(', ')} for ${session.agent.name}`
              + `${plan.names.length > 0 ? ', inside its workspace' : ''}, until revoked`
            : 'always this scope'
          : always === 'origin'
            ? 'always this site'
            : always === 'tool'
              ? `always for ${session.agent.name}, until revoked`
              : always === 'destination'
                ? `always ${destination} for ${session.agent.name}, until revoked`
                : 'always this session';
      const outcome = mode === 'remote'
        ? await awaitRemote(context, request!, origin, oneShot, always, reviewAsk?.note)
        : await awaitPrompt(context, ask!, command, origin, alwaysMeans, reviewAsk?.note);

      if (outcome === ABORTED) {
        return report(context, 'cancelled', false, `${call.toolName} was cancelled while awaiting approval`);
      }
      const { answer, actor } = outcome;

      if (answer === 'deny') {
        return report(
          context,
          'approver',
          false,
          mode === 'remote'
            ? `${call.toolName} was not approved`
            : `${call.toolName} was refused at the prompt`,
          command,
          undefined,
          origin,
        );
      }

      /**
       * Allow — unless the conversation moved out from under the answer.
       *
       * The origin was read before the wait, and the wait is a human's:
       * fifteen minutes by default, unbounded when the timeout is zero. A
       * page that navigates inside it (a redirect, a meta refresh, a
       * script) would have a yes given for site A land a click on site B,
       * with the prompt still naming A. The approver answered a question
       * about a page; if it is not that page any more, there is no answer
       * to act on, and re-asking is not the fix — that is a second question
       * with the same race behind it.
       *
       * Every path out of the approval goes through this, and it is the
       * *last* thing each of them does, because the answer is not the last
       * yield: persisting a grant is a disk write, and a store somebody
       * else wrote has no bound at all. Checking once when the answer
       * arrives would leave exactly that window open. One chokepoint, so a
       * path added later cannot quietly skip it.
       *
       * A grant persisted before the page moved is kept, and that is not a
       * hole: the approver read that site and said always. What must not
       * happen is the *click* landing somewhere they never saw.
       */
      const allowUnlessMoved = (reason: string, forCommand?: string): Verdict => {
        if (!scopedByOrigin) {
          return report(context, 'approver', true, reason, forCommand, undefined, origin);
        }
        const settled = originScopeFor(context.tool.originFor?.(session, call.input) ?? '')?.origin;
        if (settled === origin) {
          return report(context, 'approver', true, reason, forCommand, undefined, origin);
        }
        const approvedOn = origin ?? 'a page with no origin';
        return report(
          context,
          'approver',
          false,
          settled === undefined
            ? `${call.toolName} was approved on ${approvedOn}, and that page is no longer open`
              + ' — it did not run'
            : `${call.toolName} was approved on ${approvedOn}, but the conversation is on ${settled} now`
              + ' — it did not run',
          undefined,
          undefined,
          origin,
        );
      };

      if (answer === 'always') {
        if (externalGate || reviewing) {
          // Before every branch that remembers something, because each of
          // them would: `oneShot` told the transport not to offer this, and
          // a prompt someone typed "always" into is not a transport that
          // listened.
          return allowUnlessMoved(
            reviewing
              ? `${call.toolName} was approved once; under the review posture nothing is remembered`
              : `${call.toolName} was approved once; this conversation has read external content, so nothing is remembered`,
            command,
          );
        }
        if (scopedByOrigin) {
          // The tool goes in with the site: a grant for one origin-scoped
          // tool is not a grant for another (see `OriginScope.tool`).
          const grant: OriginScope | undefined = originScope ? { ...originScope, tool: call.toolName } : undefined;
          if (!grant) {
            // No origin to remember — a page that never loaded, or one
            // whose URL has no origin this engine will name. The call runs;
            // nothing is widened. Falling back to the tool-wide grant here
            // would turn "always on this page" into "always on every page",
            // which is the grant this whole engine replaced.
            return allowUnlessMoved(
              `${call.toolName} was approved once; there is no page origin to remember, so it will ask again`,
            );
          }
          if (origins?.whitelist) {
            try {
              await origins.whitelist.rememberOrigin(session.agent.id, grant);
            } catch (error) {
              if (!(error instanceof WhitelistUnreadableError)) {
                throw error;
              }
              // Same bargain the command half makes: the answer holds for
              // this process, and the file that would carry it past a
              // restart is not written over grants nobody can read.
              rememberForProcess(sessionOrigins, session.agent.id, grant);
              return allowUnlessMoved(
                `${call.toolName} was approved, and ${describeOriginScope(grant)} is acted on without asking for ${session.agent.id} until the daemon restarts — not saved: ${error.message}`,
              );
            }
            origins.onScopeRemembered?.({ agentId: session.agent.id, scope: grant });
          } else {
            rememberForProcess(sessionOrigins, session.agent.id, grant);
          }
          return allowUnlessMoved(
            `${call.toolName} was approved, and ${describeOriginScope(grant)} is now acted on without asking`,
          );
        }
        if (usePlan) {
          if (plan === undefined) {
            return allowUnlessMoved(
              `${call.toolName} was approved once; it cannot be reduced to grants, so it will ask again`,
              command,
            );
          }
          const agentId = session.agent.id;
          const saved: string[] = [];
          let unsaved: string | undefined;
          for (const name of plan.names) {
            const grant: CommandNameGrant = {
              command: name,
              grantedAt: new Date().toISOString(),
              ...(actor !== undefined ? { grantedBy: actor } : {}),
            };
            if (commands?.names && unsaved === undefined) {
              try {
                await commands.names.rememberCommandName(agentId, grant);
                commands.onCommandNameRemembered?.({ agentId, grant });
                saved.push(name);
                continue;
              } catch (error) {
                if (!(error instanceof WhitelistUnreadableError)) {
                  throw error;
                }
                unsaved = error.message;
              }
            }
            rememberForProcess(sessionNames, agentId, grant);
            saved.push(name);
          }
          for (const scope of plan.scopes) {
            if (commands?.whitelist && unsaved === undefined) {
              try {
                await commands.whitelist.remember(agentId, scope);
                commands.onScopeRemembered?.({ agentId, scope });
                saved.push(describeCommandScope(scope));
                continue;
              } catch (error) {
                if (!(error instanceof WhitelistUnreadableError)) {
                  throw error;
                }
                unsaved = error.message;
              }
            }
            rememberForProcess(sessionScopes, agentId, scope);
            saved.push(describeCommandScope(scope));
          }
          const list = saved.map((entry) => `"${entry}"`).join(', ');
          return allowUnlessMoved(
            unsaved === undefined
              ? `${call.toolName} was approved, and ${list} now run${saved.length === 1 ? 's' : ''} without asking`
              : `${call.toolName} was approved, and ${list} run without asking for ${agentId} until the daemon restarts — not saved: ${unsaved}`,
            command,
          );
        }
        const scope = commandScope;
        if (analysis && !scope) {
          // A command this parser could not reduce to a scope — a pipe, a
          // subshell, an unbalanced quote. "Always" must not fall back to
          // the tool-wide grant here: the approver widened one command they
          // read, and remembering `shell.run` instead would hand the agent
          // every command for the rest of the session.
          return allowUnlessMoved(
            `${call.toolName} was approved once; it cannot be reduced to a scope, so it will ask again`,
            command,
          );
        }
        if (scope) {
          // A scope, never the command string (useless next time) and never
          // the bare executable (a shell). `git push origin main` persists
          // `git push` minus its destructive forms, so `git push --force`
          // asks again.
          if (commands?.whitelist) {
            try {
              await commands.whitelist.remember(session.agent.id, scope);
            } catch (error) {
              if (!(error instanceof WhitelistUnreadableError)) {
                throw error;
              }
              // The answer stands for as long as tier one does — this
              // process, for this agent, which is what the person's
              // "always" means without a file — and the file that would
              // carry it past a restart is not written over grants nobody
              // can read. The line says both.
              rememberForProcess(sessionScopes, session.agent.id, scope);
              return allowUnlessMoved(
                `${call.toolName} was approved, and "${describeCommandScope(scope)}" runs without asking for ${session.agent.id} until the daemon restarts — not saved: ${error.message}`,
                command,
              );
            }
            commands.onScopeRemembered?.({ agentId: session.agent.id, scope });
          } else {
            rememberForProcess(sessionScopes, session.agent.id, scope);
          }
          return allowUnlessMoved(
            `${call.toolName} was approved, and "${describeCommandScope(scope)}" now runs without asking`,
            command,
          );
        }
        if (risk === 'dangerous') {
          // The tier means "a human every time, whatever scopes exist", and
          // it kept that name in this change on exactly that basis — no
          // first-party tool is in it any more, so what it is *for* is an
          // operator's `toolRisks` or a plugin manifest saying it about
          // somebody else's code. A session-wide grant made that a promise
          // about the first call only (28 names this and calls tightening
          // it deliberate); it is now what it says.
          return allowUnlessMoved(
            `${call.toolName} was approved once; a dangerous tool is never remembered, so it will ask again`,
          );
        }
        if (multiplyScoped) {
          // The other half of the multi-hook rule. Storing a tool-wide
          // grant here would be the engine answering "how do two scopes
          // compose?" with "they do not apply", which is the one answer
          // nobody would choose deliberately.
          return allowUnlessMoved(
            `${call.toolName} was approved once; it names more than one kind of scope, so it will ask again`,
          );
        }
        if (unscoped) {
          // The standing grant. Recorded with the tool's contributor and
          // with who answered, because both are unanswerable afterwards from
          // anything else: a listing has to say which package's `web.fetch`
          // was granted, and by whom. Kept for this process whatever the
          // store does, which is what "always" means without a file.
          const grant: ToolGrant = {
            tool: call.toolName,
            ...(contributor !== undefined ? { package: contributor } : {}),
            grantedAt: new Date().toISOString(),
            ...(actor !== undefined ? { grantedBy: actor } : {}),
          };
          if (grants?.store) {
            try {
              await grants.store.rememberTool(session.agent.id, grant);
            } catch (error) {
              if (!(error instanceof WhitelistUnreadableError)) {
                throw error;
              }
              // The same bargain as the two scope kinds: the answer holds
              // for this process, and the file is not written over grants
              // nobody can read.
              rememberForProcess(processGrants, session.agent.id, grant);
              return allowUnlessMoved(
                `${call.toolName} was approved, and runs without asking for ${session.agent.id} until the daemon restarts — not saved: ${error.message}`,
              );
            }
            grants.onGranted?.({ agentId: session.agent.id, grant });
          } else {
            rememberForProcess(processGrants, session.agent.id, grant);
          }
          return allowUnlessMoved(
            `${call.toolName} was approved, and ${describeToolGrant(grant)} now runs without asking for ${session.agent.id} until revoked`,
          );
        }
        if (destination !== undefined) {
          // One conversation, one tool, until revoked — never the tool on
          // every conversation (see `destinations.ts`).
          const grant: DestinationGrant = {
            tool: call.toolName,
            destination,
            ...(account !== undefined ? { account } : {}),
            ...(contributor !== undefined ? { package: contributor } : {}),
            grantedAt: new Date().toISOString(),
            ...(actor !== undefined ? { grantedBy: actor } : {}),
          };
          if (destinations?.whitelist) {
            try {
              await destinations.whitelist.rememberDestination(session.agent.id, grant);
            } catch (error) {
              if (!(error instanceof WhitelistUnreadableError)) {
                throw error;
              }
              rememberForProcess(processDestinations, session.agent.id, grant);
              return allowUnlessMoved(
                `${call.toolName} was approved, and ${describeDestinationGrant(grant)} runs without asking for ${session.agent.id} until the daemon restarts — not saved: ${error.message}`,
              );
            }
            destinations.onGranted?.({ agentId: session.agent.id, grant });
          } else {
            rememberForProcess(processDestinations, session.agent.id, grant);
          }
          return allowUnlessMoved(
            `${call.toolName} was approved, and ${describeDestinationGrant(grant)} now runs without asking for ${session.agent.id} until revoked`,
          );
        }
        alwaysAllowed.add(sessionKey(session.id, call.toolName));
        return allowUnlessMoved(`${call.toolName} was approved for the rest of this session`);
      }

      return allowUnlessMoved(`${call.toolName} was approved once`, command);
    },
  };
  return policy;
};

export {
  assertDerivedStatePath,
  assertDerivedStatePathSync,
  linkedDerivedComponent,
  linkedDerivedComponentMessage,
  linkedDerivedComponentSync,
  isSymlinkedStatePath,
  isSymlinkedStatePathSync,
  symlinkedStateDirectoryMessage,
  symlinkedStateFileMessage,
} from './state-directory.ts';
