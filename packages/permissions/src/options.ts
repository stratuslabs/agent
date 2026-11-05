/**
 * The policy's contract: how it reaches a person (`PermissionMode`,
 * `ApprovalRequest`), what it reports for each call (`PermissionDecision`),
 * and the options `createPermissionPolicy` takes for each kind of grant.
 */
import type {
  AlwaysMeans,
  ApprovalAnswer,
  ApprovalOutcome,
  ApprovalVerdict,
  Session,
  Tool,
  ToolCall,
  ToolRisk,
} from '@stratusagent/core';

import type { CommandScope } from './commands.ts';
import type { CommandNameGrant } from './compound.ts';
import type { DestinationGrant } from './destinations.ts';
import type { ToolGrant } from './grants.ts';
import type { OriginScope } from './origins.ts';
import type { ReviewCode, ReviewOptions } from './review.ts';
import type {
  CommandNameStore,
  CommandWhitelistStore,
  DestinationWhitelistStore,
  OriginWhitelistStore,
  ToolGrantStore,
} from './whitelist.ts';

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
