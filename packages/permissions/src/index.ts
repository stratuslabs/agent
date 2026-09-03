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
import { WhitelistUnreadableError, type CommandWhitelistStore } from './whitelist.ts';

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
  createFileCommandWhitelist,
  whitelistPathFor,
  WhitelistUnreadableError,
  type CommandWhitelistStore,
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
  const what = command !== undefined
    ? `${call.toolName}: ${command}`
    : argumentSummary !== undefined
      ? `${call.toolName} (${risk}): ${argumentSummary}`
      : `${call.toolName} (${risk})`;
  const always = command === undefined ? 'always this session' : 'always this scope';
  const pending = ask(
    `Allow ${what} for ${session.agent.name}? [y]es / [a]lways (${always}) / [N]o: `,
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
): Promise<ApprovalAnswer | typeof ABORTED> => {
  const pending = request({
    session: context.session,
    call: context.call,
    tool: context.tool,
    risk: context.risk,
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
 */
export const createPermissionPolicy = (options: PermissionPolicyOptions): ApprovalPolicy => {
  const { mode, ask, request, onDecision, commands, destinations } = options;
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

  const report = (
    context: ApprovalContext,
    allowed: boolean,
    reason: string,
    command?: string,
    destination?: string,
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
      } else if (alwaysAllowed.has(sessionKey(session.id, call.toolName))) {
        return report(context, true, `${call.toolName} was approved for the rest of this session`);
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
          command === undefined
            ? `${call.toolName} is ${risk} and nobody is available to approve it`
            : `${call.toolName} was called outside every approved scope`
              + `${analysis?.base ? ` (${analysis.base})` : ''} and nobody is available to approve it`,
          command,
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
      const answer = mode === 'remote'
        ? await awaitRemote(context, request!)
        : await awaitPrompt(context, ask!, command);

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
        );
      }

      if (answer === 'always') {
        const scope = analysis ? normalizeCommandScope(analysis) : undefined;
        if (analysis && !scope) {
          // A command this parser could not reduce to a scope — a pipe, a
          // subshell, an unbalanced quote. "Always" must not fall back to
          // the tool-wide grant here: the approver widened one command they
          // read, and remembering `shell.run` instead would hand the agent
          // every command for the rest of the session.
          return report(
            context,
            true,
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
              // The answer stands for this session — the person gave it —
              // and the file that would carry it further is not written
              // over grants nobody can read. The line says both.
              return report(
                context,
                true,
                `${call.toolName} was approved, and "${describeCommandScope(scope)}" runs without asking for the rest of this session — not saved: ${error.message}`,
                command,
              );
            }
            commands.onScopeRemembered?.({ agentId: session.agent.id, scope });
          }
          return report(
            context,
            true,
            `${call.toolName} was approved, and "${describeCommandScope(scope)}" now runs without asking`,
            command,
          );
        }
        alwaysAllowed.add(sessionKey(session.id, call.toolName));
        return report(context, true, `${call.toolName} was approved for the rest of this session`);
      }

      return report(context, true, `${call.toolName} was approved once`, command);
    },
  };
};
