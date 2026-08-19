import type {
  ApprovalAnswer,
  ApprovalContext,
  ApprovalPolicy,
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
import type { CommandWhitelistStore } from './whitelist.ts';

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
  /** One line, written for a person reading a daemon log at 3am. */
  reason: string;
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
  const what = command === undefined ? `${call.toolName} (${risk})` : `${call.toolName}: ${command}`;
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
  const { mode, ask, request, onDecision, commands } = options;
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

  const report = (context: ApprovalContext, allowed: boolean, reason: string): boolean => {
    onDecision?.({
      allowed,
      mode,
      risk: context.risk,
      toolName: context.call.toolName,
      sessionId: context.session.id,
      agentId: context.session.agent.id,
      reason,
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
              `${call.toolName} cannot run unattended (${analysis.disqualifiedBy}): ${command}`,
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
              `${command} is inside the approved scope "${describeCommandScope(scope)}"`,
            );
          }
        }
      } else if (alwaysAllowed.has(sessionKey(session.id, call.toolName))) {
        return report(context, true, `${call.toolName} was approved for the rest of this session`);
      }

      if (mode === 'headless') {
        return report(
          context,
          false,
          command === undefined
            ? `${call.toolName} is ${risk} and nobody is available to approve it`
            : `${command} is outside every approved scope and nobody is available to approve it`,
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
        );
      }

      if (answer === 'always') {
        const scope = analysis ? normalizeCommandScope(analysis) : undefined;
        if (scope) {
          // A scope, never the command string (useless next time) and never
          // the bare executable (a shell). `git push origin main` persists
          // `git push` minus its destructive forms, so `git push --force`
          // asks again.
          sessionScopes.set(session.agent.id, [...(sessionScopes.get(session.agent.id) ?? []), scope]);
          if (commands?.whitelist) {
            await commands.whitelist.remember(session.agent.id, scope);
            commands.onScopeRemembered?.({ agentId: session.agent.id, scope });
          }
          return report(
            context,
            true,
            `${command} was approved, and "${describeCommandScope(scope)}" now runs without asking`,
          );
        }
        alwaysAllowed.add(sessionKey(session.id, call.toolName));
        return report(context, true, `${call.toolName} was approved for the rest of this session`);
      }

      return report(
        context,
        true,
        command === undefined ? `${call.toolName} was approved once` : `${command} was approved once`,
      );
    },
  };
};
