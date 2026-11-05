/*
 * Approval requests as Slack buttons: rendering a parked tool call as a
 * prompt, retiring a prompt nobody in this process posted, and retracting
 * one once the request is resolved. Moved out of
 * `createSlackChannelAdapter` in index.ts as is: the statements are
 * unchanged, inside a factory that takes what they closed over there, and
 * the adapter calls it exactly where they were. The one edit:
 * `gatewayRef` is a `let` that `start` sets, so it is read through
 * `getGateway()`. Nothing here is public.
 */

import type { GatewayLike, StratusEvent } from '@stratusagent/core';
import type { AgentConnection } from './connection.ts';
import type { PendingApprovalPost } from './pending-posts.ts';
import { alwaysOutcome, approvalBlocks, escapeSlackText, OUTCOME_TEXT, renderInvocation } from './prompts.ts';
import type { SlackBlock, SlackSocketEventArgs } from './index.ts';

/** What createApprovalPrompts closes over: values createSlackChannelAdapter owns. */
export interface ApprovalPromptsDeps {
  warn: (line: string) => void;
  configuredAgents: Set<string>;
  approvalPosts: Map<string, PendingApprovalPost>;
  rendering: Set<string>;
  resolvedWhileRendering: Map<string, Extract<StratusEvent, { type: 'tool.approval-resolved' }>>;
  getGateway: () => GatewayLike | undefined;
  connectionFor: (agentId: string) => AgentConnection | undefined;
}

export const createApprovalPrompts = ({
  warn,
  configuredAgents,
  approvalPosts,
  rendering,
  resolvedWhileRendering,
  getGateway,
  connectionFor,
}: ApprovalPromptsDeps) => {
  /**
   * Renders one parked call as buttons and remembers where it went.
   *
   * A request this adapter cannot route is DENIED here rather than left to
   * expire: with no approver configured, or no conversation to ask in,
   * waiting out the timeout tells the agent nothing it will not be told
   * immediately, and holds the turn (and the thread it is answering) open
   * for the whole window to get there.
   */
  const renderApprovalRequest = async (
    event: Extract<StratusEvent, { type: 'tool.approval-requested' }>,
  ): Promise<void> => {
    const gateway = getGateway();
    if (!gateway) {
      return;
    }

    // A delegated call is asked where the work was asked for: the
    // delegating conversation, through the app and approvers of the agent
    // at the root of the chain. The agent doing the work may have no
    // connection here at all, and its sub-session has no conversation of
    // its own — asked the old way, nobody saw it and the turn sat out the
    // whole timeout. The gateway makes such a call one-shot, so routing it
    // through another agent's approvers never grants anything standing.
    const origin = event.delegatedFrom;
    const viaOrigin = origin ? connectionFor(origin.agentId) : undefined;
    const connection = viaOrigin ?? connectionFor(event.agentId);
    // A call whose conversation is another channel's (a Discord thread), or
    // whose schedule reports through another channel, is that channel's to
    // ask: it renders the request where the work was asked for. Asked or
    // denied here, it would be refused before the person who can answer it
    // ever saw it. An approval channel is the operator naming where to ask
    // whatever the conversation, so it still applies, which needs a live
    // connection; with none, this adapter has nothing to say about it.
    const home = (origin ? origin.metadata : event.metadata) ?? {};
    const homeChannel = typeof home.channel === 'string' ? home.channel.trim().toLowerCase() : undefined;
    const reportsElsewhere = event.scheduleDestination !== undefined
      && event.scheduleDestination.channel.trim().toLowerCase() !== 'slack';
    const anotherChannels = (homeChannel !== undefined && homeChannel !== 'slack') || (homeChannel === undefined && reportsElsewhere);
    if (anotherChannels && !connection?.config.approvalChannel) {
      return;
    }
    if (!connection) {
      // Two different situations, and only one of them is this adapter's
      // to answer.
      //
      // An agent it was configured for but could not connect (a failed
      // auth, a dead app token) is its own: it was supposed to carry that
      // agent's approvals and cannot, so it says so rather than letting
      // every gated call wait out the timeout.
      //
      // An agent it was never configured for is NOT. Approval requests are
      // a broadcast, and another channel may be the one that serves that
      // agent — denying here would let Slack refuse a question somebody
      // else was going to ask. `stratus serve` reports agents that no
      // channel can ask for, at startup, where the whole roster is visible.
      if (configuredAgents.has(event.agentId) || (origin && configuredAgents.has(origin.agentId))) {
        warn(`slack: ${origin?.agentId ?? event.agentId} has no live connection; denying ${event.call.toolName}`);
        gateway.resolveApproval({ requestId: event.requestId, answer: 'deny', reason: 'undeliverable' });
      }
      return;
    }

    const approvers = new Set((connection.config.approvers ?? []).filter((id) => id.length > 0));
    const metadata = (viaOrigin ? origin?.metadata : event.metadata) ?? {};
    const sameChannel = metadata.channel === 'slack' && typeof metadata.slackChannel === 'string'
      ? metadata.slackChannel
      : undefined;
    // A scheduled firing has no conversation of its own. With no approval
    // channel configured it used to be denied at its first gated call, seen
    // only in the daemon log (card 218). Its schedule's destination is a
    // conversation a person approved as where it speaks, and only approvers
    // can answer there, so that is where it is asked. A configured approval
    // channel still wins: the operator chose it for exactly this. Another
    // channel's destination is not a Slack conversation id.
    const scheduled = event.scheduleDestination?.channel.trim().toLowerCase() === 'slack'
      ? event.scheduleDestination
      : undefined;
    const viaSchedule = !sameChannel && !connection.config.approvalChannel ? scheduled : undefined;
    const channel = sameChannel ?? connection.config.approvalChannel ?? viaSchedule?.to;
    const thread = sameChannel
      ? (typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined)
      : viaSchedule?.thread;

    // Undeliverable, not decided: nobody was asked, so filing this next to
    // the denials somebody actually made would make the audit record lie
    // about which is which.
    const decline = (reason: string): void => {
      warn(`slack: ${reason}; denying ${event.call.toolName} for ${event.agentId}`);
      gateway.resolveApproval({ requestId: event.requestId, answer: 'deny', reason: 'undeliverable' });
    };

    if (approvers.size === 0) {
      decline(`no approvers configured for ${connection.config.agentId}`);
      return;
    }
    if (!channel) {
      decline(`no conversation to ask in for ${connection.config.agentId}`);
      return;
    }

    const nameOf = (agentId: string): string => gateway.agents().find((agent) => agent.id === agentId)?.name ?? agentId;
    // "Quinn (for Nova)": the approver is being asked about Quinn's call,
    // by Nova's app, in Nova's conversation, and should be told both.
    const agentName = viaOrigin && origin && origin.agentId !== event.agentId
      ? `${nameOf(event.agentId)} (for ${nameOf(origin.agentId)})`
      : nameOf(event.agentId);
    // The notification preview is all some approvers see before deciding
    // whether to open the thread, so it carries the arguments too — just
    // the short form.
    const invocationSummary = renderInvocation(event.call.input).summary;

    // The post is the only awaited step, and the only window in which the
    // request can settle behind this function's back — so it is the only
    // step `rendering` covers, and nothing decides anything until it is
    // over and the two possible outcomes can be told apart.
    rendering.add(event.requestId);
    let post: PendingApprovalPost | undefined;
    let failure: string | undefined;
    try {
      const posted = await connection.web.chat.postMessage({
        channel,
        // Fallback text for notifications and clients that do not render
        // blocks — an approval nobody can read is an approval nobody gives.
        text: escapeSlackText(
          `${agentName} wants to run ${event.call.toolName} (${event.risk})`
          + `${event.origin ? ` on ${event.origin}` : ''}`
          + `${invocationSummary ? `: ${invocationSummary}` : ''}.`,
        ),
        ...(thread ? { thread_ts: thread } : {}),
        blocks: approvalBlocks(
          agentName,
          event.call.toolName,
          event.risk,
          event.requestId,
          event.call.input,
          event.origin,
          event.oneShot === true,
          event.always,
          event.reviewNote,
        ),
      });
      post = posted.ts
        ? {
            connection,
            channel: posted.channel ?? channel,
            ts: posted.ts,
            ...(thread ? { thread } : {}),
            agentName,
            toolName: event.call.toolName,
            risk: event.risk,
            oneShot: event.oneShot === true,
            ...(event.always !== undefined ? { always: event.always } : {}),
            agentId: event.agentId,
            approvers,
          }
        : undefined;
      failure = post ? undefined : `Slack accepted the approval request for ${event.agentId} without a timestamp`;
    } catch (error) {
      failure = `could not post an approval request to ${channel} (${error instanceof Error ? error.message : String(error)})`;
    }
    rendering.delete(event.requestId);

    if (post) {
      approvalPosts.set(event.requestId, post);
    }

    const settledMeanwhile = resolvedWhileRendering.get(event.requestId);
    if (settledMeanwhile) {
      resolvedWhileRendering.delete(event.requestId);
      // Already decided — never decline it a second time; just take the
      // buttons off the message that just appeared.
      if (post) {
        await retractApprovalRequest(settledMeanwhile);
      }
      return;
    }

    if (failure) {
      decline(failure);
    }
  };

  /**
   * Retracts the buttons once a request is settled, however it settled.
   * Every ending goes through here — a click, the timeout, a cancelled turn
   * — so a message can never keep offering a decision that no longer has
   * anywhere to land.
   */
  /**
   * Rewrites a prompt left behind by a daemon that is gone, using the
   * click's own coordinates.
   *
   * The index of posted requests is in-memory and keyed by request id, so
   * a new process starts empty and has no way to find the messages its
   * predecessor posted. An interaction payload carries the channel and
   * timestamp of the message it came from, which is the one handle on such
   * a message that survives — so the click that discovers the prompt is
   * dead is also what retires it. Unclicked orphans stay as they are;
   * clearing those needs the posts to be durable, which is a larger change
   * than this and belongs to both billing paths equally.
   */
  const offersDecision = (blocks: SlackBlock[] | undefined): boolean =>
    (blocks ?? []).some((block) => block.type === 'actions');

  const retireOrphanedPrompt = async (
    connection: AgentConnection,
    args: SlackSocketEventArgs,
  ): Promise<void> => {
    const channel = args.body?.channel?.id;
    const ts = args.body?.message?.ts;
    if (!channel || !ts) {
      return;
    }
    // The message decides, not a memory of it. Every ending rewrites this
    // message into a plain section, so buttons still on it mean nothing
    // has been written there yet — and no buttons means something has, and
    // overwriting it would replace a real outcome and the person who made
    // it. Reading the click's own copy answers that with no bookkeeping to
    // disagree with, and no second API call to ask.
    if (!offersDecision(args.body?.message?.blocks)) {
      return;
    }
    const text = 'This request is no longer pending — the daemon that asked it is no longer running.';
    try {
      await connection.web.chat.update({
        channel,
        ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
    } catch (error) {
      warn(`slack: could not retire an orphaned request: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const retractApprovalRequest = async (
    event: Extract<StratusEvent, { type: 'tool.approval-resolved' }>,
  ): Promise<void> => {
    const post = approvalPosts.get(event.requestId);
    if (!post) {
      // Still being posted: hold the outcome so the message it is about to
      // create does not keep offering a decision that is already made.
      if (rendering.has(event.requestId)) {
        resolvedWhileRendering.set(event.requestId, event);
      }
      return;
    }
    approvalPosts.delete(event.requestId);

    // The one lifetime this adapter *can* tell, because it rode in on the
    // request: a one-shot call remembers nothing whatever is answered. Both
    // shapes reach here — a `dangerous` tool, and a call judged by an
    // origin with no page to grant — and this channel offers no **Always
    // allow** for either, but `POST /approvals` still takes all three
    // answers, so another client can submit one. The general line below has
    // to hedge between two lifetimes it cannot distinguish; this one must
    // not, or the record of the decision claims a grant that does not exist.
    // Three shapes are one-shot and only one of them is knowable from here:
    // `risk` rode in on the request, so a `dangerous` tool can say why. The
    // other two — a browser action with no page to grant, and a command the
    // parser cannot reduce to a scope — are not distinguishable without
    // carrying a reason this adapter would only ever print, so they share a
    // line that is true of both. Naming one of them by guess is how this
    // read "there was no page to remember" for a shell pipeline.
    const outcome = post.oneShot && event.reason === 'decided' && event.answer === 'always'
      ? post.risk === 'dangerous'
        ? 'Allowed once — a dangerous tool is never remembered'
        : 'Allowed once — nothing about this call could be remembered'
      : event.reason === 'decided' && event.answer === 'always'
        ? alwaysOutcome(post.always, post.agentName, post.agentId)
        : OUTCOME_TEXT[`${event.reason}:${event.answer}`] ?? 'Resolved';
    // A mention only for an actor this post knows as a Slack user — its
    // approvers, which is the only set a click can come from. An approval
    // decided through the control API arrives as `api:…` or `dashboard`,
    // and `<@api:ops-bot>` is not a mention, it is a broken one; escaped
    // plain text says who it was.
    const by = event.actor
      ? ` by ${post.approvers.has(event.actor) ? `<@${event.actor}>` : escapeSlackText(event.actor)}`
      : '';
    const text = `*${escapeSlackText(post.agentName)}* — \`${escapeSlackText(post.toolName)}\` (${post.risk}): ${outcome}${by}.`;
    try {
      await post.connection.web.chat.update({
        channel: post.channel,
        ts: post.ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
    } catch (error) {
      warn(`slack: could not update a resolved approval request: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return { renderApprovalRequest, retireOrphanedPrompt, retractApprovalRequest };
};

export type ApprovalPrompts = ReturnType<typeof createApprovalPrompts>;
