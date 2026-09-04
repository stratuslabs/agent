import type {
  ApprovalAnswer,
  ApprovalContext,
  ApprovalPolicy,
  JsonObject,
  JsonValue,
  Session,
  Tool,
  ToolCall,
  ToolRisk,
} from '@stratusagent/core';

/**
 * Re-exported, not re-implemented: the risk ordering moved to the kernel
 * when the plugin loader became its second consumer, and this package
 * published the name first.
 */
export { atLeastAsRisky } from '@stratusagent/core';

import {
  analyzeCommand,
  describeCommandScope,
  findMatchingScope,
  normalizeCommandScope,
  SAFE_COMMAND_SCOPES,
  type CommandScope,
} from './commands.ts';
import {
  describeOriginScope,
  findMatchingOriginScope,
  originScopeFor,
  type OriginScope,
} from './origins.ts';
import {
  WhitelistUnreadableError,
  type CommandWhitelistStore,
  type OriginWhitelistStore,
} from './whitelist.ts';

export {
  analyzeCommand,
  describeCommandScope,
  findMatchingScope,
  matchesScope,
  normalizeCommandScope,
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
  type OriginScope,
} from './origins.ts';
export {
  createFileCommandWhitelist,
  whitelistPathFor,
  WhitelistUnreadableError,
  type CommandWhitelistStore,
  type OriginWhitelistStore,
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
   * which of the two lifetimes is still not knowable here, and is why the
   * wording for that case has to cover both.
   */
  oneShot?: boolean;
  /**
   * When this call first parked, if it is being re-asked after a restart.
   * A transport that imposes a deadline measures from here rather than
   * granting a fresh window.
   */
  parkedAt?: string;
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
 */
export type ApprovalRequester = (request: ApprovalRequest) => Promise<ApprovalAnswer>;

/** Why a call was allowed or refused, for logs and events. */
export interface PermissionDecision {
  allowed: boolean;
  mode: PermissionMode;
  risk: ToolRisk;
  toolName: string;
  sessionId: string;
  agentId: string;
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
}

export interface CommandScopeOptions {
  /**
   * Scopes that run unattended. Defaults to `SAFE_COMMAND_SCOPES`; pass a
   * list to replace it, or spread it to extend.
   */
  safeScopes?: readonly CommandScope[];
  /** Where "always allow" persists a scope, and where one is read back. */
  whitelist?: CommandWhitelistStore;
  /**
   * Called when a scope is persisted. The daemon logs it: an approval that
   * widens what runs unattended, for every future session, is exactly the
   * decision that must not be the one leaving no trace.
   */
  onScopeRemembered?: (event: { agentId: string; scope: CommandScope }) => void;
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
}

const YES = new Set(['y', 'yes', 'always', 'a']);
const ALWAYS = new Set(['always', 'a']);

const ABORTED = Symbol('aborted');

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
): Promise<ApprovalAnswer | typeof ABORTED> => {
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
    `Allow ${what} for ${session.agent.name}? [y]es / [a]lways (${alwaysMeans}) / [N]o: `,
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
    return 'deny';
  }
  return ALWAYS.has(answer) ? 'always' : 'once';
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
): Promise<ApprovalAnswer | typeof ABORTED> => {
  const pending = request({
    session: context.session,
    call: context.call,
    tool: context.tool,
    risk: context.risk,
    ...(origin !== undefined ? { origin } : {}),
    ...(oneShot ? { oneShot } : {}),
    ...(context.parkedAt ? { parkedAt: context.parkedAt } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  }).then(
    (answer) => answer,
    () => 'deny' as const,
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
 */
export const createPermissionPolicy = (options: PermissionPolicyOptions): ApprovalPolicy => {
  const { mode, ask, request, onDecision, commands, destinations, origins } = options;
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
  // process's life. It is not merely a cache of the file — a policy built
  // with no whitelist store still has to remember an answer for the rest of
  // the session, which is what `always` means at a terminal.
  const sessionScopes = new Map<string, CommandScope[]>();
  /** The same tier for origins, and for the same reason. */
  const sessionOrigins = new Map<string, OriginScope[]>();

  const report = (
    context: ApprovalContext,
    allowed: boolean,
    reason: string,
    command?: string,
    destination?: string,
    origin?: string,
  ): boolean => {
    onDecision?.({
      allowed,
      mode,
      risk: context.risk,
      toolName: context.call.toolName,
      sessionId: context.session.id,
      agentId: context.session.agent.id,
      reason,
      ...(command === undefined ? {} : { command }),
      ...(destination === undefined ? {} : { destination }),
      ...(origin === undefined ? {} : { origin }),
    });
    return allowed;
  };

  return {
    async approve(context: ApprovalContext): Promise<boolean> {
      const { call, risk, session } = context;

      if (risk === 'safe') {
        return report(context, true, `${call.toolName} is safe and runs without approval`);
      }

      // What this *invocation* would run, for a tool whose danger lives in
      // its arguments. Resolved before anything else so that the tool-wide
      // "always" below can never apply to it: one yes to `git status` must
      // not become a standing yes to every command the shell can run.
      const command = risk === 'gated' ? context.tool.commandFor?.(call.input) : undefined;
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
      // A tool that offers both is judged by the command and only the
      // command: two engines over one call would need a rule for which
      // wins, and the honest one — the narrower — is what a single engine
      // already gives. Nothing offers both today; this is what keeps that
      // true if something ever does.
      const scopedByOrigin = risk === 'gated'
        && context.tool.originFor !== undefined
        && context.tool.commandFor === undefined;
      // The grants first, and where the page is *after* them. Read the
      // other way round, the store's disk read sits between the two, and a
      // page that redirects inside it has a grant for site A allow a click
      // on site B — the same shape as the approval wait below, with a
      // shorter gap and no bound on it at all when the store is somebody
      // else's. There is no await between this read and the match, so the
      // origin a grant is checked against is where the conversation is when
      // the decision is made, not where it was.
      const grantedOrigins = scopedByOrigin
        ? [
            ...(sessionOrigins.get(session.agent.id) ?? []),
            ...(origins?.whitelist ? await origins.whitelist.originsFor(session.agent.id) : []),
          ]
        : [];
      const reportedOrigin = scopedByOrigin ? context.tool.originFor?.(session) : undefined;
      // Read through the same normalizer a grant file is read through,
      // rather than taken as written. The hook's contract is an origin, but
      // this is what a grant is compared against — a plugin that hands back
      // a whole page URL should get a grant on its origin, not one that
      // silently never matches anything.
      const originScope = reportedOrigin === undefined ? undefined : originScopeFor(reportedOrigin);
      const origin = originScope?.origin;

      if (analysis) {
        if (analysis.disqualifiedBy) {
          // Never auto-approved, whatever the base command is: a safe scope
          // in front of a pipe is the exact shape this rule exists for.
          if (mode === 'headless') {
            return report(
              context,
              false,
              `${call.toolName} cannot run unattended: ${analysis.disqualifiedBy}`,
              command,
            );
          }
        } else {
          const stored = commands?.whitelist ? await commands.whitelist.scopesFor(session.agent.id) : [];
          const candidates = [
            ...(sessionScopes.get(session.agent.id) ?? []),
            ...stored,
            ...(commands?.safeScopes ?? SAFE_COMMAND_SCOPES),
          ];
          const scope = findMatchingScope(analysis, candidates);
          if (scope) {
            return report(
              context,
              true,
              `${call.toolName} ran inside the approved scope "${describeCommandScope(scope)}"`,
              command,
            );
          }
        }
      } else if (risk !== 'dangerous'
        && !scopedByOrigin
        && alwaysAllowed.has(sessionKey(session.id, call.toolName))) {
        return report(context, true, `${call.toolName} was approved for the rest of this session`);
      }

      if (origin !== undefined) {
        const granted = findMatchingOriginScope(origin, grantedOrigins);
        if (granted) {
          return report(
            context,
            true,
            `${call.toolName} acted on the approved site ${describeOriginScope(granted)}`,
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
      if (risk === 'gated' && destinations) {
        const destination = context.tool.destinationFor?.(call.input);
        if (destination !== undefined
          && await destinations.isPreauthorized(session, destination)) {
          return report(
            context,
            true,
            `${call.toolName} to ${destination} was pre-authorized when this schedule was approved`,
            undefined,
            destination,
          );
        }
      }

      if (mode === 'headless') {
        return report(
          context,
          false,
          command !== undefined
            ? `${call.toolName} was called outside every approved scope`
              + `${analysis?.base ? ` (${analysis.base})` : ''} and nobody is available to approve it`
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
        return report(context, false, `${call.toolName} was cancelled before it could be approved`);
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
      const oneShot = risk === 'dangerous'
        || (scopedByOrigin && origin === undefined)
        || (analysis !== undefined && commandScope === undefined);
      const alwaysMeans = oneShot
        ? risk === 'dangerous'
          ? 'not remembered — a dangerous tool asks every time'
          : analysis !== undefined
            ? 'not remembered — this command cannot be reduced to a scope'
            : 'not remembered — there is no page to grant'
        : command !== undefined
          ? 'always this scope'
          : scopedByOrigin
            ? 'always this site'
            : 'always this session';
      const answer = mode === 'remote'
        ? await awaitRemote(context, request!, origin, oneShot)
        : await awaitPrompt(context, ask!, command, origin, alwaysMeans);

      if (answer === ABORTED) {
        return report(context, false, `${call.toolName} was cancelled while awaiting approval`);
      }

      if (answer === 'deny') {
        return report(
          context,
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
      const allowUnlessMoved = (reason: string, forCommand?: string): boolean => {
        if (!scopedByOrigin) {
          return report(context, true, reason, forCommand, undefined, origin);
        }
        const settled = originScopeFor(context.tool.originFor?.(session) ?? '')?.origin;
        if (settled === origin) {
          return report(context, true, reason, forCommand, undefined, origin);
        }
        const approvedOn = origin ?? 'a page with no origin';
        return report(
          context,
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
        if (scopedByOrigin) {
          if (!originScope) {
            // No origin to remember — a page that never loaded, or one
            // whose URL has no origin this engine will name. The call runs;
            // nothing is widened. Falling back to the tool-wide grant here
            // would turn "always on this page" into "always on every page",
            // which is the grant this whole engine replaced.
            return allowUnlessMoved(
              `${call.toolName} was approved once; there is no page origin to remember, so it will ask again`,
            );
          }
          sessionOrigins.set(session.agent.id, [...(sessionOrigins.get(session.agent.id) ?? []), originScope]);
          if (origins?.whitelist) {
            try {
              await origins.whitelist.rememberOrigin(session.agent.id, originScope);
            } catch (error) {
              if (!(error instanceof WhitelistUnreadableError)) {
                throw error;
              }
              // Same bargain the command half makes: the answer holds for
              // this process, and the file that would carry it past a
              // restart is not written over grants nobody can read.
              return allowUnlessMoved(
                `${call.toolName} was approved, and ${describeOriginScope(originScope)} is acted on without asking for ${session.agent.id} until the daemon restarts — not saved: ${error.message}`,
              );
            }
            origins.onScopeRemembered?.({ agentId: session.agent.id, scope: originScope });
          }
          return allowUnlessMoved(
            `${call.toolName} was approved, and ${describeOriginScope(originScope)} is now acted on without asking`,
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
          sessionScopes.set(session.agent.id, [...(sessionScopes.get(session.agent.id) ?? []), scope]);
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
              return allowUnlessMoved(
                `${call.toolName} was approved, and "${describeCommandScope(scope)}" runs without asking for ${session.agent.id} until the daemon restarts — not saved: ${error.message}`,
                command,
              );
            }
            commands.onScopeRemembered?.({ agentId: session.agent.id, scope });
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
        alwaysAllowed.add(sessionKey(session.id, call.toolName));
        return allowUnlessMoved(`${call.toolName} was approved for the rest of this session`);
      }

      return allowUnlessMoved(`${call.toolName} was approved once`, command);
    },
  };
};
