/*
 * The Approvals menu of `stratus setup`: where approval prompts reach a
 * person, in Slack and through the control API and dashboard. Moved out of
 * `runSetup` in setup.ts as is: the statements are unchanged, inside a
 * factory that takes the values they closed over there, and `runSetup`
 * destructures what it returns.
 */

import { resolveAgentApprovals } from '@stratusagent/state';
import { type ApprovalReach, classifyApprovalReach, unattendedReachParts } from '../../approvals.ts';
import { writeLine } from '../../io.ts';
import { packageInstalled } from '../../loaders.ts';
import { menuPrefixWidth } from '../../prompter.ts';
import type { SetupBase } from './context.ts';
import type { SharedSetup } from './shared.ts';

export const createApprovalSetup = ({
  state,
  env,
  serveCommand,
  prompter,
  streams,
  channelRoster,
  fitMenuRow,
}: Pick<SetupBase, 'state' | 'env' | 'serveCommand' | 'prompter' | 'streams'> & Pick<SharedSetup, 'channelRoster' | 'fitMenuRow'>) => {
  /**
   * Who may answer a gated call while nobody is watching. The two halves
   * are one decision: `remote` with nobody to ask behaves exactly like
   * `headless` — the call parks and the timeout denies it — so the mode
   * and the approvers are set on the same screen rather than in two places
   * that can disagree.
   */
  /**
   * The daemon's own verdict, not a second version of it. Every round of
   * review on this row found the hand-written summary short a clause the
   * engine applies — headless still runs already-authorized calls, an
   * explicit `timeoutMs: 0` parks instead of denying, the control API can
   * answer for an agent Slack cannot reach. The row now takes the first
   * clause `stratus plugins` prints and the submenu carries the rest, so
   * the two can differ in length and never in fact.
   */
  const approvalsSummary = async (): Promise<string[]> => {
    const mode = state.approvals?.mode ?? 'headless';
    const { entries, loaded } = await channelRoster();
    // `headless` is a statement about the policy, not the roster, so it
    // survives a roster that will not load. Everything else here depends on
    // who is served: passing `undefined` would make `classifyApprovalReach`
    // skip the intersection and read every stored token as askable, so the
    // row would promise Slack asks for a fleet whose gateway refuses to
    // start. Same rule as the grant line and the Channels menu — an
    // unreadable roster is not evidence in either direction.
    if (mode === 'remote' && !loaded) {
      return ['remote — who can be asked is unknown until the roster loads; fix the error above, then `stratus plugins`'];
    }
    return unattendedReachParts(
      mode,
      state.approvals ?? {},
      state.channels,
      entries.map((entry) => entry.soul.agent.id),
      apiApprovalsReachable(),
      env,
    );
  };

  /** Whether a parked call could be settled through `POST /api/v1/approvals`. */
  const apiApprovalsReachable = (): boolean =>
    packageInstalled('@stratusagent/control-api', env) && state.api?.enabled !== false;

  const approvalReach = async (): Promise<ApprovalReach> => {
    const { entries, loaded } = await channelRoster();
    return classifyApprovalReach(
      state.approvals ?? {},
      state.channels,
      loaded ? entries.map((entry) => entry.soul.agent.id) : undefined,
      env,
    );
  };

  /**
   * Agents that can actually be asked: stored Slack tokens intersected with
   * the roster. A token that outlived its agent is offered nowhere — the
   * Slack adapter skips it (`no roster agent with id …`), so approvers
   * named for it configure a route no call can take. `stratus plugins`
   * learned this the same way; the Channels menu shows such tokens as
   * orphans and is the one place they are reachable, to be cleared.
   *
   * A roster that failed to load is not evidence of an orphan, so the raw
   * list stands in that case — the same posture the Channels menu takes,
   * for the same reason: acting on "no agent has this id" when the roster
   * could not say who its agents are destroys working configuration.
   */
  /**
   * Agents whose approvers this screen may edit: stored tokens intersected
   * with the roster, and deliberately *not* gated on the adapter being
   * installed.
   *
   * Reachability and editability are different questions here, and only on
   * this screen. `offerOptionalPackages()` runs inside `save()`, after the
   * menu — so on a first install the operator connects Slack under
   * Channels, opens Approvals, and the package that will be installed
   * moments later is still absent. Gating the rows on it left the fresh
   * install with nothing to configure and no way back into the menu,
   * which is the one path this whole PR exists to make work.
   *
   * The *verdict* keeps the package gate, because that is a claim about
   * what a daemon would do rather than about what may be written now.
   */
  const configurableSlackAgents = async (): Promise<string[]> => {
    const stored = Object.keys(state.channels.slack ?? {});
    const { entries, loaded } = await channelRoster();
    if (!loaded) {
      return stored;
    }
    return stored.filter((agentId) => entries.some((entry) => entry.soul.agent.id === agentId));
  };

  const chooseApprovals = async (): Promise<void> => {
    while (true) {
      const mode = state.approvals?.mode ?? 'headless';
      const connected = await configurableSlackAgents();
      // Two modes, a row per connected agent when remote, and Back.
      const reserved = menuPrefixWidth(2 + (mode === 'remote' ? connected.length : 0) + 1);
      // Static text, and still fitted: with `(current)` shown this row runs
      // to 76 columns including the selection prefix, so it clears an
      // 80-column terminal by four and wraps on anything narrower — and a
      // wrapped row corrupts every redraw, because the rewind counts
      // options rather than rendered rows. Being static is not being short.
      const options = [
        fitMenuRow(`Headless${mode === 'headless' ? ' (current)' : ''}          refuse calls that need a person's approval`, reserved),
        fitMenuRow(`Ask in Slack${mode === 'remote' ? ' (current)' : ''}       park the turn and ask an approver`, reserved),
      ];
      if (mode === 'remote') {
        for (const agentId of connected) {
          // The *resolved* answer, through the rule the daemon uses: an
          // agent with no override of its own inherits the top-level list,
          // and reading the override alone would report "nobody" for an
          // agent a global list already covers.
          const resolved = resolveAgentApprovals(state.approvals, agentId);
          const own = state.approvals?.agents?.[agentId]?.slackApprovers;
          const approvers = resolved.slackApprovers ?? [];
          const label = approvers.length === 0
            ? '— nobody, so its calls are denied'
            : own === undefined
              ? `${approvers.join(', ')} (inherited)`
              : approvers.join(', ');
          // Fitted like the top-level row, and for the same reason: several
          // approvers, or one long agent id, is enough to wrap — and the
          // redraw rewinds by option count, not by rendered rows. Every
          // option in every menu has this constraint; these are the ones
          // this PR adds.
          options.push(fitMenuRow(`  approvers for ${agentId}`.padEnd(26) + label
            + (approvers.length > 0 && !resolved.slackChannel ? ' · no fallback channel' : ''), reserved));
        }
      }
      options.push('Back');

      // Said here because it is only true here: tokens are stored, the
      // adapter is not installed yet, and Save is about to offer it. The
      // rows are editable regardless — the alternative was a first install
      // with nothing to configure.
      const adapterPending = connected.length > 0 && !packageInstalled('@stratusagent/channel-slack', env);
      // The whole verdict, never trimmed: a footnote is drawn once, outside
      // the redraw loop, so wrapping costs nothing here — and this is the
      // screen where the trimmed row's remainder belongs.
      const verdict = (await approvalsSummary()).join('; ');
      const footnote = adapterPending
        ? `${verdict}. @stratusagent/channel-slack is not installed yet — Save & finish offers it, and these approvers apply once it is. ${serveCommand()} brings them online.`
        : mode === 'remote' && connected.length === 0
          // The advice comes *after* the verdict, never instead of it: with
          // the control API up a parked call is already answerable, and
          // replacing the verdict here told the operator to go connect
          // Slack while the row above said the API had it. The screen that
          // changes the mode must not answer differently from the row.
          ? `${verdict}. No agent is connected to Slack, so connect one under Channels to be asked there.`
          : verdict;
      const choice = await prompter.select(
        'Approvals — what happens to a gated call with nobody watching',
        options,
        { footnote },
      );
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }
      if (choice.index === 0) {
        state.approvals = { ...(state.approvals ?? {}), mode: 'headless' };
        continue;
      }
      if (choice.index === 1) {
        state.approvals = { ...(state.approvals ?? {}), mode: 'remote' };
        continue;
      }
      const agentId = connected[choice.index - 2];
      if (!agentId) {
        continue;
      }
      const resolved = resolveAgentApprovals(state.approvals, agentId);
      const current = resolved.slackApprovers ?? [];
      // Prefilled with the resolved list, and `ask` returns the prefill for
      // an empty line — so Enter keeps what is on screen and can never
      // revoke anything. That matters here more than elsewhere:
      // `resolveAgentApprovals` reads `agent ?? global` and an empty array
      // is not nullish, so a written `[]` is the config's way of *excluding*
      // an agent from the global list, not of leaving it alone.
      const answer = (await prompter.ask(
        `Slack user ids who may approve for ${agentId} (comma-separated, e.g. U01ABCDEF; Enter to keep): `,
        ...(current.length > 0 ? [{ prefill: current.join(', ') }] : []),
      )).trim();
      const approvers = answer.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
      const agents = { ...(state.approvals?.agents ?? {}) };
      const entry = { ...(agents[agentId] ?? {}) };
      const inheriting = state.approvals?.agents?.[agentId]?.slackApprovers === undefined;
      const unchanged = approvers.length === current.length
        && approvers.every((id, index) => id === current[index]);
      if (approvers.length === 0) {
        // An empty answer must never *widen*. With a top-level list in play
        // this writes the explicit `[]` the config reserves for excluding
        // an agent from it, because deleting the key would hand those
        // approvers an agent that had been kept from them — either one the
        // operator excluded on purpose, or one whose narrower list they
        // just erased. `[]` and an absent key differ here in exactly the
        // direction that matters, and the previous round fixed the other
        // half of this: never write `[]` over a list nobody touched.
        const globalApprovers = state.approvals?.slackApprovers ?? [];
        const hadOwn = state.approvals?.agents?.[agentId]?.slackApprovers !== undefined;
        if (globalApprovers.length > 0 || hadOwn) {
          // `[]` outlives the list it excludes from. With no top-level
          // approvers today the two look identical, but deleting the key
          // means the agent silently joins whatever list is added tomorrow
          // — so an exclusion already on disk is preserved, not tidied
          // away because it happens to be inert right now.
          entry.slackApprovers = [];
          writeLine(streams.stdout, globalApprovers.length > 0
            ? `${agentId} is excluded from the top-level approvers (${globalApprovers.join(', ')}), so nobody may approve for it and its gated calls are denied.`
            : `${agentId} has no approvers, so its gated calls are denied — and it stays excluded if a top-level list is added later.`);
        } else {
          // Never had one and nothing to inherit: an absent key is what
          // "unset" looks like, and writing `[]` would invent an exclusion
          // the operator never asked for.
          delete entry.slackApprovers;
        }
      } else if (inheriting && unchanged) {
        // Keeping an inherited list must not freeze it: writing the same ids
        // as this agent's own override would look identical today and stop
        // tracking the top-level list the operator edits tomorrow.
        writeLine(streams.stdout, `${agentId} still inherits the top-level approvers (${current.join(', ')}).`);
      } else {
        entry.slackApprovers = approvers;
      }

      if (entry.slackApprovers !== undefined || resolved.slackApprovers !== undefined) {
        // The other half of a working route, and the half a fresh install
        // has no way to guess it needs. A turn that arrived through Slack
        // is answered in its own thread, and a schedule's firing in the
        // destination it reports to, but one from a schedule with no Slack
        // destination, a delegation or the control API reaches the adapter
        // with nowhere to ask and is denied undeliverable — so approvers alone
        // configure approvals for exactly the calls least likely to need
        // them. `stratus plugins` reports this state; better not to create
        // it here in the first place.
        // "Enter to skip" is only true with nothing prefilled. `ask` returns
        // the prefill for an empty line, so where a channel already resolves
        // Enter *keeps* it — an operator told otherwise would believe they
        // had removed a fallback that goes on receiving approval details.
        // The same correction the approvers prompt above already carries.
        //
        // What clearing the line does, though, is decided by whether this
        // agent *owns* the channel, not by whether one resolves: clearing
        // an inherited one deletes a key that was never there and the
        // global goes on resolving. Reading the offer off the resolved
        // value promised a removal the branch below then refuses — the
        // prompt and its own outcome disagreeing about the same keypress.
        const ownChannel = state.approvals?.agents?.[agentId]?.slackChannel;
        const globalChannel = state.approvals?.slackChannel;
        const hasChannel = resolved.slackChannel !== undefined;
        const channelOffer = ownChannel !== undefined
          ? (globalChannel !== undefined
            ? `(Enter to keep it; clear the line to fall back to the top-level ${globalChannel}): `
            : '(Enter to keep it; clear the line to remove it): ')
          : hasChannel
            ? '(Enter to go on inheriting it; type another to give this agent its own): '
            : '(e.g. C0123456, Enter to skip): ';
        const channelAnswer = (await prompter.ask(
          `Which Slack channel should ${agentId} ask in when the turn did not start in Slack? ${channelOffer}`,
          ...(hasChannel ? [{ prefill: resolved.slackChannel as string }] : []),
        )).trim();
        // The same inheritance trap as the approvers above, one field over:
        // the prompt is prefilled with the resolved value, so keeping an
        // inherited channel would write it as this agent's own and stop it
        // tracking the top-level one. Both fields need the guard; fixing
        // only the one under review is how this arrived here twice.
        const inheritsChannel = ownChannel === undefined;
        if (channelAnswer.length > 0 && inheritsChannel && channelAnswer === resolved.slackChannel) {
          writeLine(streams.stdout, `${agentId} still inherits the top-level fallback channel (${channelAnswer}).`);
        } else if (channelAnswer.length > 0) {
          entry.slackChannel = channelAnswer;
        } else if (resolved.slackChannel !== undefined) {
          // Blanked deliberately: an editable prefill makes this reachable.
          // What it can mean depends on whether a top-level channel exists,
          // and only one of the two is "no fallback" — clearing the
          // override otherwise moves the agent onto the global channel,
          // which is a different, possibly wider place to post approval
          // details. Setup says which happened rather than assuming.
          //
          // Untested for the same reason the roots deletion above is: an
          // empty answer where a prefill exists is a TTY-only path, since
          // the piped prompter returns `line || prefill` and `setupInput`
          // forces it.
          delete entry.slackChannel;
          writeLine(streams.stdout, globalChannel !== undefined
            ? `${agentId} ${inheritsChannel ? 'still uses' : 'now uses'} the top-level fallback channel (${globalChannel})${inheritsChannel ? '' : ' instead of its own'}. Setup cannot turn the fallback off for one agent — remove approvals.slackChannel to drop it for everyone.`
            : `${agentId} has no fallback channel now: only turns already in Slack can be asked.`);
        } else {
          writeLine(streams.stdout, `No fallback channel for ${agentId}: only turns already in Slack and schedules that report to Slack can be asked, and a delegated or API-started call is denied undeliverable.`);
        }
      }

      agents[agentId] = entry;
      state.approvals = { ...(state.approvals ?? {}), mode: 'remote', agents };
    }
  };

  return { approvalsSummary, chooseApprovals };
};

export type ApprovalSetup = ReturnType<typeof createApprovalSetup>;
