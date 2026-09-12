import { createInterface } from 'node:readline';
import {
  AllowAllApprovalPolicy,
  originOf,
  type ApprovalContext,
  type ApprovalPolicy,
} from '@stratusagent/core';
import {
  loadChannelCredentials,
  resolveAgentApprovals,
  resolveAgentPrincipals,
  type ApprovalsConfig,
  type PrincipalsConfig,
  type ChannelCredentials,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from './environment.ts';
import { writeLine } from './io.ts';
import { packageInstalled } from './loaders.ts';
import type { CliApprovalMode } from './parse.ts';

/**
 * Where a call would act, for a tool that answers that — read through
 * `originOf` so this and the daemon's engine compare the same thing.
 */
const approvalOrigin = (context: ApprovalContext): string | undefined => {
  const reported = context.tool.originFor?.(context.session);
  return reported === undefined ? undefined : originOf(reported);
};

/**
 * What a local prompt asks about: the tool, where it would act when that is
 * a question at all, and the arguments.
 *
 * The origin is not in the arguments and cannot be — a `browser.act` call
 * carries a CSS selector, and `#submit` is equally "load more results" and
 * "confirm purchase". A prompt that showed only the selector would be
 * asking someone to authorize an effect whose location it withheld, which
 * is the same reason the daemon's prompt and the Slack request name it.
 */
export const describeApprovalCall = (context: ApprovalContext): string => {
  const origin = approvalOrigin(context);
  return `${context.call.toolName}${origin ? ` on ${origin}` : ''}`
    + ` with input ${JSON.stringify(context.call.input)}`;
};

/**
 * Whether the conversation is still on the page the prompt named.
 *
 * A y/N at a terminal takes as long as it takes, and the page is live for
 * all of it: a redirect between the question and the answer would have a
 * yes given for one site click on another, with the prompt still showing
 * the first. So the origin is read again and a page that moved refuses —
 * the same check the daemon's engine makes after its own approval wait.
 * This local policy needs its own because it is a separate policy sharing
 * none of that code: `--approvals ask` judges the call, not a scope.
 *
 * Said out loud rather than failing quietly: somebody typed `y` and is owed
 * an explanation for why nothing happened.
 */
const stillOnApprovedPage = (
  context: ApprovalContext,
  approved: string | undefined,
  streams: CliStreams,
): boolean => {
  if (context.tool.originFor === undefined) {
    return true;
  }
  const now = approvalOrigin(context);
  if (now === approved) {
    return true;
  }
  writeLine(
    streams.stderr,
    `Not running ${context.call.toolName}: it was approved on ${approved ?? 'a page with no origin'}, `
    + `and the conversation ${now === undefined ? 'no longer has that page open' : `is on ${now} now`}.`,
  );
  return false;
};

export const createApprovalPolicy = (
  mode: CliApprovalMode,
  streams: CliStreams,
  env: CliEnvironment,
  ask?: (prompt: string) => Promise<string>,
): ApprovalPolicy => {
  if (mode === 'always') {
    return new AllowAllApprovalPolicy();
  }

  if (mode === 'never') {
    return {
      async approve() {
        return false;
      },
    };
  }

  // A caller that already owns stdin (chat's readline) supplies its own
  // asker — two readers on one stream would race for the same bytes.
  if (ask) {
    return {
      async approve(context) {
        const approved = approvalOrigin(context);
        const answer = await ask(`Approve tool call ${describeApprovalCall(context)}? [y/N] `);
        return /^y(es)?$/i.test(answer.trim()) && stillOnApprovedPage(context, approved, streams);
      },
    };
  }

  return {
    async approve(context) {
      const input = env.approvalInput ?? process.stdin;
      const readline = createInterface({ input, terminal: false });
      const approved = approvalOrigin(context);

      // Prompt on stderr so stdout stays parseable (e.g. --format json).
      streams.stderr.write(`Approve tool call ${describeApprovalCall(context)}? [y/N] `);

      try {
        const answer = await new Promise<string>((resolve) => {
          readline.once('line', resolve);
          readline.once('close', () => resolve(''));
        });
        writeLine(streams.stderr);
        return /^y(es)?$/i.test(answer.trim()) && stillOnApprovedPage(context, approved, streams);
      } finally {
        readline.close();
      }
    },
  };
};

/** One line saying whose messages arrive as the operator's, per Slack agent. */
export const describePrincipals = (principals: PrincipalsConfig, agentIds: string[]): string => {
  const covered = agentIds.filter((agentId) => (resolveAgentPrincipals(principals, agentId).slackUsers ?? []).length > 0);
  // Which agents refuse the unlisted outright, so an operator reading the
  // startup line knows whether the list is a label or a door. Worked out
  // before the no-list case: a closed agent with nobody listed refuses
  // everyone, which is a valid configuration and the opposite of "every
  // sender is unknown".
  const closed = agentIds.filter((agentId) => resolveAgentPrincipals(principals, agentId).admit === 'principals');
  const door = closed.length === 0
    ? '; every agent still admits unlisted senders as unknown (principals.admit: "principals" refuses them)'
    : closed.length === agentIds.length
      ? '; unlisted senders are refused'
      : `; unlisted senders are refused by ${closed.join(', ')} and admitted as unknown by the rest`;
  if (covered.length === 0) {
    return closed.length === 0
      ? 'no principals configured, so every Slack sender is unknown and every fact written in Slack carries that label — set principals.slackUsers in ~/.stratus/config.json'
      : `no principals listed, so every Slack sender is unknown${door} — nobody at all can talk to ${closed.join(', ')} until principals.slackUsers names someone`;
  }
  // An uncovered agent's senders are all unknown only if it admits them: a
  // closed agent with nobody listed refuses everyone, and saying its
  // senders are "all unknown" and then "refused" in one line is a summary
  // that contradicts itself about the one thing it exists to say.
  const uncovered = agentIds.filter((agentId) => !covered.includes(agentId));
  const uncoveredOpen = uncovered.filter((agentId) => !closed.includes(agentId));
  const uncoveredClosed = uncovered.filter((agentId) => closed.includes(agentId));
  return `principals set for ${covered.join(', ')}`
    + (uncoveredOpen.length > 0 ? `; none for ${uncoveredOpen.join(', ')}, whose Slack senders are all unknown` : '')
    + (uncoveredClosed.length > 0
      ? `; none for ${uncoveredClosed.join(', ')}, who refuse every sender until principals.slackUsers names someone`
      : '')
    + door;
};

/**
 * Which of these agents the Slack adapter would actually ask about, and
 * which it would decline for. Separated from the sentence below because
 * two callers need the *answer* and only one needs it as prose: a summary
 * that says a call "asks in Slack" must not say it about an agent the
 * adapter denies on arrival.
 */
const classifyApprovers = (
  approvals: ApprovalsConfig,
  agentIds: string[],
): { covered: string[]; uncovered: string[] } => {
  const covered = agentIds.filter((agentId) => (resolveAgentApprovals(approvals, agentId).slackApprovers ?? []).length > 0);
  return { covered, uncovered: agentIds.filter((agentId) => !covered.includes(agentId)) };
};

export const describeApprovers = (approvals: ApprovalsConfig, agentIds: string[]): string => {
  if (agentIds.length === 0) {
    return 'but no channel is running to ask through, so gated calls will wait out the approval timeout and then be denied';
  }
  const { covered, uncovered } = classifyApprovers(approvals, agentIds);
  if (covered.length === 0) {
    return 'but no approvers are configured, so every gated call is denied on arrival';
  }
  return uncovered.length === 0
    ? `approvers set for ${covered.join(', ')}`
    : `approvers set for ${covered.join(', ')}; none for ${uncovered.join(', ')}, whose calls are denied on arrival`;
};

/**
 * The ways a gated call is already authorized before either mode's decision
 * is reached — the standing tool grants, the approved command scopes, the
 * approved sites, and a schedule's pre-authorized destination, in the order
 * `createPermissionPolicy` checks them.
 *
 * Written once because it is read twice: enumerating it separately per mode
 * is what left the destination path out of one of them and out of the other
 * entirely. It is prose about a rule `@stratusagent/permissions` owns, so
 * when that engine gains a path this string is what has to follow it.
 */
const ALREADY_AUTHORIZED = 'standing grants, approved command scopes and sites (stratus grants <agent>), '
  + 'and destinations pre-authorized with a schedule (stratus schedules)';

/**
 * What a gated call would actually meet on this machine.
 *
 * The mode is not the answer on its own, in both directions. `headless`
 * refuses a gated call *last*: the engine checks the standing tool grants,
 * the approved command scopes, and the approved sites first, so an agent
 * that was ever told "always allow" runs that tool unattended for good
 * (`stratus grants <agent>` is what lists them). And `remote` only asks if
 * somebody can be asked — with no channel to render the request a gated
 * call waits out the timeout, and with no approver configured it is denied
 * on arrival, which is `headless` by another name.
 *
 * Stating either as "gated calls are refused" or "gated calls are asked in
 * Slack" would be wrong in exactly the configurations an operator runs this
 * command to understand.
 */
/**
 * Who can actually be asked, and what is missing for the rest. Split out of
 * the sentence below because two surfaces need the *answer*: `stratus
 * plugins` renders it as a paragraph, setup's Approvals row as a menu
 * summary, and a second hand-rolled copy of "who is askable" drifted from
 * this one within three PRs — stored tokens read as reachable agents when
 * the package was absent, when the agent had left the roster, and when the
 * only route left was the control API.
 */
export interface ApprovalReach {
  /** Tokens stored, package installed, agent still served. */
  askable: string[];
  /** Of those, the ones an approver is named for — the rest are denied on arrival. */
  covered: string[];
  /** Of those, the ones with no conversation to ask in for a turn that did not start in Slack. */
  noFallback: string[];
}

export const classifyApprovalReach = (
  approvals: ApprovalsConfig,
  channels: ChannelCredentials,
  servedAgentIds: readonly string[] | undefined,
  env: CliEnvironment,
): ApprovalReach => {
  // An adapter that is not installed renders nothing, so its stored tokens
  // are not a route — `runServe` starts without the Slack channel and says
  // so. Undefined served ids means the roster did not load, which is not
  // evidence that any token is orphaned.
  const stored = packageInstalled('@stratusagent/channel-slack', env)
    ? Object.keys(channels.slack ?? {})
    : [];
  const askable = servedAgentIds === undefined
    ? stored
    : stored.filter((agentId) => servedAgentIds.includes(agentId));
  const { covered } = classifyApprovers(approvals, askable);
  const noFallback = covered.filter((agentId) => resolveAgentApprovals(approvals, agentId).slackChannel === undefined);
  return { askable, covered, noFallback };
};

export const describeUnattendedReach = async (
  mode: 'headless' | 'remote',
  approvals: ApprovalsConfig,
  env: CliEnvironment,
  /**
   * The agents actually being served, or undefined when the roster did not
   * load. Stored Slack tokens outlive the agent they were stored for, and
   * the adapter skips an id the gateway is not serving — so a token with no
   * agent behind it must not read as somebody who can be asked.
   *
   * `runServe` prints its own line without this intersection, and is right
   * to: at startup the roster has not loaded yet. It reports the reverse
   * direction separately once it has one, warning about served agents no
   * channel can ask for. Here both are in view from the start.
   */
  servedAgentIds: readonly string[] | undefined,
  /**
   * Whether the control API would be serving. It is a second way to answer
   * a parked call — `GET /api/v1/approvals` lists them, `POST` settles one
   * — so an agent no Slack channel can ask for is not necessarily an agent
   * nobody can ask.
   */
  apiReachable: boolean,
): Promise<string> => {
  const channels = await loadChannelCredentials(env);
  return unattendedReachParts(mode, approvals, channels, servedAgentIds, apiReachable, env).join('; ');
};

/**
 * The clauses above, unjoined and without reading the filesystem, so a
 * caller holding unsaved state can render the same verdict. The first
 * element is always the verdict itself; the rest qualify it.
 *
 * Split out because setup's Approvals row wrote its own version of this
 * sentence, and every review round found it short a different clause the
 * daemon actually applies — the headless exceptions, an explicit
 * `timeoutMs: 0`, the control API on a mixed roster. There is one renderer
 * now; a menu that wants a shorter line takes fewer clauses, never
 * different words.
 */
export const unattendedReachParts = (
  mode: 'headless' | 'remote',
  approvals: ApprovalsConfig,
  channels: ChannelCredentials,
  servedAgentIds: readonly string[] | undefined,
  apiReachable: boolean,
  env: CliEnvironment,
): string[] => {
  if (mode === 'headless') {
    return [`headless — an uncovered gated call is refused. Already-authorized ones still run: ${ALREADY_AUTHORIZED}`];
  }
  // The same condition `runServe` reports at startup, through the same
  // helper: an agent is askable when its tokens are stored and something is
  // installed to render the request.
  const { askable, covered, noFallback } = classifyApprovalReach(approvals, channels, servedAgentIds, env);
  // Qualified the same way the headless line is: the engine allows an
  // already-authorized call before it asks anyone, so an unqualified "asks
  // in Slack" hides unattended capability in precisely the configuration
  // where Slack is set up correctly.
  //
  // The *verdict* is composed with the control API in view rather than
  // corrected afterwards. `describeApprovers` answers a Slack question and
  // is right to — `runServe` asks it before anything else is known — but
  // its no-channel and no-approver answers both end in "denied", which is
  // false wherever `POST /api/v1/approvals` can settle the call. Appending
  // the API as a later clause left the two halves contradicting each other.
  const slack = describeApprovers(approvals, askable);
  // An explicit `timeoutMs: 0` is documented as "wait indefinitely", and
  // the gateway arms no timer for it — so a call nobody answers is not
  // eventually denied, it is parked for the life of the daemon. Promising
  // a denial understates that, and holding a turn open forever is the more
  // alarming outcome to leave unsaid.
  const expires = approvals.timeoutMs !== 0;
  const unanswered = expires ? 'before the timeout denies it' : 'and nothing else will — this daemon\'s approval timeout is 0, so it parks indefinitely';
  // Three verdicts, selected by what can actually receive the request.
  //
  // With nobody askable there is no Slack adapter in the picture at all,
  // so neither of the first two may say the call "asks in Slack" —
  // appending `describeApprovers` to that phrasing produced a sentence
  // that asked Slack and then said no Slack was running.
  //
  // The control API is offered only where Slack leaves a request parked.
  // The Slack adapter handles the same event synchronously and *denies*
  // when an agent has no approvers or no conversation to ask in, so for an
  // agent it covers there is nothing left for an API client to answer.
  // That is only true of agents it covers: one with no tokens at all
  // reaches no adapter, and its request stays parked.
  const verdict = (): string => {
    if (askable.length === 0) {
      return apiReachable
        ? `remote — an uncovered gated call parks with no Slack channel to ask through, so the control API is the only way to answer it ${unanswered}`
        : 'remote — an uncovered gated call parks with no channel to ask through and no control API to answer it, so it '
          + (expires
            ? 'waits out the approval timeout and is denied'
            : 'is never answered: this daemon\'s approval timeout is 0, so it parks indefinitely');
    }
    // "Parks and asks" is false for an agent the adapter declines: with no
    // approvers configured it calls `resolveApproval(deny)` synchronously
    // (channel-slack decline()), so nothing parks and nobody is asked.
    // Same defect as the branch above, one case over — found by auditing
    // the rest of this function after that one, not by review.
    if (covered.length === 0) {
      return 'remote — an uncovered gated call reaches Slack and is denied on arrival, because no approvers are configured';
    }
    return `remote — an uncovered gated call parks and asks in Slack, ${slack}`;
  };
  const parts = [verdict()];
  // The reverse of a stale token, and the failure that actually bites: an
  // agent the daemon serves that no channel can ask for parks its gated
  // calls until the timeout denies them. `runServe` warns about exactly
  // this once its roster loads; the difference here is only that both
  // halves are in view from the start.
  //
  // Named only when *some* agent is askable: with none, the verdict above
  // has already said no Slack channel is running at all, and listing every
  // served agent under it repeats that in more words.
  const unreachable = askable.length === 0
    ? []
    : (servedAgentIds ?? []).filter((agentId) => !askable.includes(agentId));
  if (unreachable.length > 0) {
    // Slack is not the only way to answer. `GET /api/v1/approvals` lists
    // what is parked and `POST` settles it, so with the control API up
    // these calls wait for a client rather than for the timeout — a very
    // different thing to tell an operator.
    parts.push(apiReachable
      ? `no Slack channel can ask for ${unreachable.join(', ')}, so their gated calls park until the control `
        + `API answers them${expires ? ' or the timeout denies them' : ' — with a timeout of 0, nothing else ever will'}`
      : `no channel can ask for ${unreachable.join(', ')}, so their gated calls `
        + (expires ? 'wait out the timeout and are denied' : 'park indefinitely: this daemon\'s approval timeout is 0'));
  }
  // Stored tokens are a *configured* route, not a live one. The adapter
  // pushes a connection only after `auth.test()` and `socket.start()` both
  // succeed, and `renderApprovalRequest` denies undeliverable for a
  // configured agent with no live connection — so a revoked token or a
  // dead app token turns "asks in Slack" into "denies on arrival". This
  // command reads config and manifests by design and starts no daemon, so
  // it cannot know which; saying so is the only honest option, and the
  // daemon log is where the answer actually is (`warn` writes there, so
  // `slack: could not connect <agent>` is in `stratus logs`).
  if (covered.length > 0) {
    parts.push('whether those apps are connected is not something this command can see — it reads config, '
      + 'and one whose token no longer authenticates denies its gated calls instead of asking; '
      + '`stratus logs` shows which came up');
  }
  // Approvers with nowhere to be asked outside their own thread. A turn
  // that did not start in Slack — the API, the dashboard, a delegation —
  // reaches the adapter with no destination and is denied undeliverable,
  // so "approvers set" is only half an answer without a fallback channel.
  if (noFallback.length > 0) {
    parts.push(`${noFallback.join(', ')} ${noFallback.length === 1 ? 'has' : 'have'} no slackChannel, `
      + 'so only turns already in Slack can be asked');
  }
  // What an "always allow" answer persists depends on what the call names,
  // and mostly it is not the session: `createPermissionPolicy` maps an
  // unscoped gated tool to a standing grant that outlives every restart,
  // a command to a scope, a click to a site, and only a schedule's
  // destination to the session. Saying "for the rest of its session" flat
  // understated durable unattended access, which is the wrong direction to
  // be wrong about approvals in.
  // The session case is a call scoped by *destination*, which an ordinary
  // outbound `message.send` is — not only a scheduled one. Naming the
  // schedule alone read as though the everyday case were durable.
  parts.push('an "always allow" answer persists — a standing grant for an unscoped tool, a command scope, '
    + 'or a site, all until revoked; only a call scoped by destination, such as message.send, '
    + 'lasts just the session');
  return parts;
};
