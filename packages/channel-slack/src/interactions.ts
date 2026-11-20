/*
 * Credential requests and the clicks that come back from Slack: posting a
 * credential form, its modal and submission, and `handleInteractive`,
 * which routes every button press and modal submission. Moved out of
 * `createSlackChannelAdapter` in index.ts as is: the statements are
 * unchanged, inside a factory that takes what they closed over there, and
 * the adapter calls it exactly where they were. The one edit:
 * `gatewayRef` is a `let` that `start` sets, so it is read through
 * `getGateway()`. Nothing here is public.
 */

import type { ChannelCredentialRequest, GatewayLike, StratusEvent } from '@stratusagent/core';
import type { ReplyRenderer } from './reply.ts';
import type { AgentConnection } from './connection.ts';
import { mayDecide, type PendingApprovalPost, type PendingCredentialPost } from './pending-posts.ts';
import {
  APPROVAL_ACTIONS,
  CREDENTIAL_ACK_MS,
  CREDENTIAL_ADD_ACTION,
  CREDENTIAL_BLOCK,
  CREDENTIAL_INPUT,
  CREDENTIAL_VIEW,
  credentialRequestBlocks,
  credentialShellLine,
  credentialWhose,
  escapeSlackText,
} from './prompts.ts';
import type { SlackBlock, SlackSocketEventArgs } from './index.ts';
import type { ApprovalPrompts } from './approvals.ts';

/**
 * The form. `private_metadata` carries only the request id: where the key
 * goes, and for whom, is the gateway's record of the request, never
 * something a submission can say about itself.
 */
const credentialModal = (post: PendingCredentialPost, requestId: string): SlackBlock => ({
  type: 'modal',
  callback_id: CREDENTIAL_VIEW,
  private_metadata: requestId,
  title: { type: 'plain_text', text: post.replace === true ? 'Replace a credential' : 'Add a credential' },
  submit: { type: 'plain_text', text: post.replace === true ? 'Replace' : 'Add' },
  close: { type: 'plain_text', text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: (post.replace === true
          ? `\`${escapeSlackText(post.name)}\`, ${credentialWhose(escapeSlackText(post.agentName), post.scope)}. `
            + 'The new value replaces the stored one once it saves; it never appears in the conversation.'
          : `\`${escapeSlackText(post.name)}\`, ${credentialWhose(escapeSlackText(post.agentName), post.scope)}. `
            + `It is stored add-only and granted to ${escapeSlackText(post.agentName)}; it never appears in the conversation.`)
          + (post.env !== undefined ? ` ${credentialShellLine(escapeSlackText(post.agentName), escapeSlackText(post.env))}` : ''),
      },
    },
    {
      type: 'input',
      block_id: CREDENTIAL_BLOCK,
      label: { type: 'plain_text', text: `Value for ${post.name}` },
      // Several lines: a one-line field flattens the line breaks of a pasted
      // key file, such as a PEM private key, and the key stops working.
      element: { type: 'plain_text_input', action_id: CREDENTIAL_INPUT, multiline: true },
      hint: { type: 'plain_text', text: 'Paste the whole value. A key file, such as a PEM private key, keeps its line breaks.' },
    },
  ],
});

/** What createInteractions closes over: values createSlackChannelAdapter owns. */
export interface InteractionsDeps extends Pick<ApprovalPrompts, 'retireOrphanedPrompt'> {
  warn: (line: string) => void;
  configuredAgents: Set<string>;
  renderers: Map<string, ReplyRenderer[]>;
  approvalPosts: Map<string, PendingApprovalPost>;
  credentialsPosting: Set<string>;
  credentialPosts: Map<string, PendingCredentialPost>;
  rendering: Set<string>;
  getGateway: () => GatewayLike | undefined;
  track: (work: Promise<void>) => void;
  connectionFor: (agentId: string) => AgentConnection | undefined;
}

/** What someone clicking a lookalike of an approval or credential button is told. */
const NOT_THE_PROMPT = 'That button is not on the request\'s own message, so nothing was recorded.';

export const createInteractions = ({
  warn,
  configuredAgents,
  renderers,
  approvalPosts,
  credentialsPosting,
  credentialPosts,
  rendering,
  getGateway,
  track,
  connectionFor,
  retireOrphanedPrompt,
}: InteractionsDeps) => {
  /**
   * Whether an approver can see a conversation: any public channel, or a
   * private one with an approver among its members. Rejects, with the
   * reason, when Slack will not say, so the caller refuses rather than
   * guesses.
   */
  const approverCanSee = async (connection: AgentConnection, channel: string, approvers: Set<string>): Promise<boolean> => {
    try {
      const info = (await connection.web.conversations.info({ channel })).channel;
      if (info?.is_private !== true && info?.is_mpim !== true) {
        return true;
      }
      let cursor: string | undefined;
      do {
        const page = await connection.web.conversations.members({ channel, limit: 200, ...(cursor ? { cursor } : {}) });
        if ((page.members ?? []).some((member) => approvers.has(member))) {
          return true;
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor !== undefined);
      return false;
    } catch (error) {
      throw new Error(
        `Slack would not say who can see this conversation (${error instanceof Error ? error.message : String(error)}), so the form was not posted. `
        + 'The app needs the conversations read scopes (channels:read, groups:read, mpim:read); see the app manifest.',
      );
    }
  };

  /**
   * The channel contract's `requestCredential`: posts the form and resolves
   * only once it is up with a button an approver can press. Every refusal
   * rejects with a sentence for the agent, which the gateway hands it in
   * place of "your operator was asked": a request nobody can answer would
   * otherwise sit pending while the agent says it is waiting on someone.
   */
  const requestCredential = async (request: ChannelCredentialRequest): Promise<void> => {
    const gateway = getGateway();
    const connection = connectionFor(request.agentId);
    if (!gateway || !connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `${request.agentId}'s Slack app is not connected right now.`
        : `${request.agentId} has no Slack app.`);
    }
    // Only in the conversation the agent asked in, and only for a turn this
    // adapter dispatched from a Slack message: where to post comes from
    // that turn's renderer, never from the session's metadata, which an
    // HTTP caller can write (`channel: slack`, any `slackChannel`) to put a
    // request nobody made in that conversation in front of its approvers.
    // Unlike an approval there is no fallback channel: the person who can
    // answer is the one the agent is talking to.
    const active = gateway.activeTurnId?.(request.sessionId);
    const turn = active === undefined
      ? undefined
      : (renderers.get(request.sessionId) ?? []).find((renderer) => renderer.turnId === active);
    if (!turn) {
      throw new Error('This turn did not come from a Slack message, so there is nobody in Slack to show the form to.');
    }
    const channel = turn.channel;
    const thread = turn.threadTs;
    const unseen = `Nobody who can add it can see this conversation`;
    const approvers = new Set((connection.config.approvers ?? []).filter((id) => id.length > 0));
    const agentName = gateway.agents().find((agent) => agent.id === request.agentId)?.name ?? request.agentId;
    if (approvers.size === 0 || gateway.provideCredential === undefined) {
      throw new Error(
        `Nobody can add it from Slack, because no approver is configured for ${agentName} (approvals.slackApprovers).`,
      );
    }
    // A DM has one person in it besides the app. Posted there for someone
    // who is not an approver, the form is a button only they can see and
    // only approvers can press, which is a request nobody can answer.
    const elsewhere = 'Ask in a channel an approver is in, or ask one of them directly.';
    if (turn.dmWith !== undefined && !approvers.has(turn.dmWith)) {
      throw new Error(`${unseen}: it is a direct message with someone who is not an approver for ${agentName}. ${elsewhere}`);
    }
    // A private channel or group DM shows the button only to its members,
    // so one with no approver in it is the DM case again with more people.
    // A public channel is open to anyone in the workspace, approvers
    // included, and is not checked. Unknown is refused, not assumed fine:
    // a form posted where nobody can answer it waits forever.
    if (turn.dmWith === undefined && !(await approverCanSee(connection, channel, approvers))) {
      throw new Error(`${unseen}: none of ${agentName}'s approvers is a member of this private conversation. ${elsewhere}`);
    }
    let posted: { ts?: string; channel?: string };
    credentialsPosting.add(request.requestId);
    try {
      posted = await connection.web.chat.postMessage({
        channel,
        text: escapeSlackText(`${agentName} is asking ${request.replace === true ? 'to replace' : 'for'} a credential: ${request.name}, ${credentialWhose(agentName, request.scope)}.`),
        ...(thread ? { thread_ts: thread } : {}),
        blocks: credentialRequestBlocks(agentName, request.name, request.scope, request.reason, request.requestId, request.replace === true, request.env),
      });
    } catch (error) {
      credentialsPosting.delete(request.requestId);
      warn(`slack: could not post a credential request for ${request.agentId} to ${channel} (${error instanceof Error ? error.message : String(error)})`);
      throw new Error(`Slack refused the post (${error instanceof Error ? error.message : String(error)}).`);
    }
    credentialsPosting.delete(request.requestId);
    if (!posted.ts) {
      throw new Error('Slack accepted the post but returned no message to attach the form to.');
    }
    credentialPosts.set(request.requestId, {
      connection,
      channel: posted.channel ?? channel,
      ...(thread !== undefined ? { thread } : {}),
      ts: posted.ts,
      agentId: request.agentId,
      agentName,
      name: request.name,
      scope: request.scope,
      ...(request.replace === true ? { replace: true } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      approvers,
    });
  };

  const settleCredentialPost = async (event: Extract<StratusEvent, { type: 'credential.provided' }>): Promise<void> => {
    const post = credentialPosts.get(event.requestId);
    if (!post) {
      return;
    }
    credentialPosts.delete(event.requestId);
    const whose = event.scope === 'agent'
      ? `for ${escapeSlackText(post.agentName)} only`
      : `as a shared credential, granted to ${escapeSlackText(post.agentName)}`;
    const by = event.actor !== undefined && post.approvers.has(event.actor) ? `, by <@${event.actor}>` : '';
    const shell = post.env !== undefined && event.grantError === undefined
      ? ` Its shell commands read it as \`${escapeSlackText(post.env)}\`.`
      : '';
    const text = (event.replace === true
      ? `Replaced \`${escapeSlackText(post.name)}\` ${event.scope === 'agent' ? `for ${escapeSlackText(post.agentName)}` : 'as a shared credential'}${by}. `
        + `${escapeSlackText(post.agentName)} uses the new value from its next reply; it is in the credential store, not here.`
      : event.grantError === undefined
      ? `Added \`${escapeSlackText(post.name)}\` ${whose}${by}. ${escapeSlackText(post.agentName)} can use it from its next reply; the value is in the credential store, not here.`
      : `Stored \`${escapeSlackText(post.name)}\` ${event.scope === 'agent' ? `for ${escapeSlackText(post.agentName)}` : 'as a shared credential'}${by}, `
        + `but it could not be added to ${escapeSlackText(post.agentName)}'s soul (${escapeSlackText(event.grantError)}), so ${escapeSlackText(post.agentName)} cannot use it yet. `
        + 'Add the name to the credentials list in its soul on the machine.') + shell;
    try {
      await post.connection.web.chat.update({ channel: post.channel, ts: post.ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
    } catch (error) {
      warn(`slack: could not update the credential request for ${post.agentId} (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  /**
   * Takes down a request no answer can land on any more, so its button stops
   * inviting submissions that can only be refused the same way. A request
   * `credential.provided` already settled is left to what that wrote, which
   * says more (a key stored but not granted).
   */
  const retireCredentialPost = async (requestId: string, post: PendingCredentialPost, reason: string): Promise<void> => {
    if (credentialPosts.get(requestId) !== post) {
      return;
    }
    credentialPosts.delete(requestId);
    const text = `\`${escapeSlackText(post.name)}\` was not added: ${escapeSlackText(reason)}`;
    try {
      await post.connection.web.chat.update({ channel: post.channel, ts: post.ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
    } catch (error) {
      warn(`slack: could not retire the credential request for ${post.agentId} (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  /**
   * Whether a click came from the prompt itself: the message the request
   * was posted as, in its channel. The action id and the request id in a
   * button's `value` are both readable by anyone in the thread, so without
   * this a button with the same two on any other message the app posted
   * would settle the request when an approver clicked it. Nothing posts
   * one today: a tool's post has its buttons renamed (`sanitizePostBlocks`).
   * This holds even if that ever changes (AGT-324).
   */
  const fromPrompt = (post: { channel: string; ts: string }, args: SlackSocketEventArgs): boolean =>
    args.body?.message?.ts === post.ts && args.body?.channel?.id === post.channel;

  const handleCredentialClick = async (connection: AgentConnection, args: SlackSocketEventArgs, requestId: string): Promise<void> => {
    await args.ack();
    const post = credentialPosts.get(requestId);
    if (!post && credentialsPosting.has(requestId)) {
      // Live, with the index not caught up yet: retiring it here would
      // strip the button from a request about to be registered as pending.
      await tellClicker(connection, args, 'That credential request is still being posted. Try the button again in a moment.');
      return;
    }
    if (post && !fromPrompt(post, args)) {
      await tellClicker(connection, args, NOT_THE_PROMPT);
      return;
    }
    if (!post || post.connection !== connection) {
      await tellClicker(connection, args, 'That credential request is no longer pending. Ask the agent to request it again.');
      // A daemon restart forgets every request, and the buttons it posted
      // stay live for everyone else in the thread: take this one down the
      // way an orphaned approval is, from the click's own copy.
      if (!post) {
        await retireOrphanedPrompt(connection, args);
      }
      return;
    }
    // By actor, as approvals are: the request sits in a thread anyone in
    // it can read, and a key is a bigger thing to hand over than a click.
    const clicker = args.body?.user?.id;
    if (!mayDecide(post, clicker)) {
      await tellClicker(connection, args, `You are not an approver for ${post.agentName}, so you cannot add its credentials.`);
      return;
    }
    const triggerId = args.body?.trigger_id;
    if (!connection.web.views || !triggerId) {
      await tellClicker(connection, args, 'Slack did not hand over a way to open the form. Try the button again.');
      return;
    }
    try {
      await connection.web.views.open({ trigger_id: triggerId, view: credentialModal(post, requestId) });
    } catch (error) {
      warn(`slack: could not open the credential form for ${post.agentId} (${error instanceof Error ? error.message : String(error)})`);
      await tellClicker(connection, args, 'The form could not be opened. Try the button again.');
    }
  };

  /**
   * The form's answer. Acked last rather than first, because the ack is how
   * a refusal reaches the form: `errors` keeps it open with the reason
   * beside the field, so a person told "already stored" or "no longer
   * pending" learns it where they typed. The value is read here, handed to
   * the gateway, and touched nowhere else: not logged, not posted.
   */
  const handleCredentialSubmission = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    const refuse = (message: string): Promise<void> =>
      args.ack({ response_action: 'errors', errors: { [CREDENTIAL_BLOCK]: message } });
    const view = args.body?.view;
    const requestId = view?.private_metadata ?? '';
    const post = credentialPosts.get(requestId);
    const gateway = getGateway();
    if (!post || post.connection !== connection || !gateway?.provideCredential) {
      await refuse('That credential request is no longer pending. Ask the agent to request it again.');
      return;
    }
    // Checked again on the answer, not only on the click: the form is a
    // separate interaction, and the click is not what stores anything.
    const submitter = args.body?.user?.id;
    if (!mayDecide(post, submitter)) {
      await refuse(`You are not an approver for ${post.agentName}, so you cannot add its credentials.`);
      return;
    }
    const value = view?.state?.values?.[CREDENTIAL_BLOCK]?.[CREDENTIAL_INPUT]?.value ?? '';
    const answer = gateway.provideCredential({ requestId, value, actor: submitter }).catch(
      (error: unknown): { ok: false; message: string; retired?: boolean } => ({
        ok: false,
        message: `It could not be stored: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    // Slack wants the submission acked within three seconds, and storing
    // is two locked file writes and every bus subscriber: usually far
    // inside that, not always. An answer in time keeps the form open with
    // a refusal beside the field; a late one closes the form first and
    // tells the submitter privately, rather than letting Slack time out
    // and retry a submission the first attempt may already have stored.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), CREDENTIAL_ACK_MS);
    });
    const first = await Promise.race([answer, deadline]);
    clearTimeout(timer);
    if (first !== 'late') {
      // A plain ack closes the form. The message is rewritten from
      // `credential.provided`, the one path every way of answering goes
      // through.
      await (first.ok ? args.ack() : refuse(first.message));
      if (!first.ok && first.retired === true) {
        track(retireCredentialPost(requestId, post, first.message));
      }
      return;
    }
    await args.ack();
    track(answer.then(async (result) => {
      if (result.ok) {
        return;
      }
      if (result.retired === true) {
        await retireCredentialPost(requestId, post, result.message);
      }
      try {
        await connection.web.chat.postEphemeral({
          channel: post.channel,
          user: submitter,
          text: `${post.name} was not added: ${result.message}`,
          ...(post.thread !== undefined ? { thread_ts: post.thread } : {}),
        });
      } catch (error) {
        warn(`slack: could not tell ${submitter} a credential was not added (${error instanceof Error ? error.message : String(error)})`);
      }
    }));
  };

  const handleInteractive = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    if (args.body?.type === 'view_submission') {
      if (args.body.view?.callback_id === CREDENTIAL_VIEW) {
        await handleCredentialSubmission(connection, args);
      } else {
        await args.ack();
      }
      return;
    }
    const first = args.body?.actions?.[0];
    if (first?.action_id === CREDENTIAL_ADD_ACTION && first.value) {
      await handleCredentialClick(connection, args, first.value);
      return;
    }
    // Ack first and unconditionally: Slack retries an unacked interaction,
    // and a redelivered click on a request that is no longer pending would
    // read as a second, rejected decision.
    await args.ack();

    const gateway = getGateway();
    const action = args.body?.actions?.[0];
    const answer = action?.action_id ? APPROVAL_ACTIONS[action.action_id] : undefined;
    const requestId = action?.value;
    if (!gateway || !answer || !requestId) {
      return;
    }

    const post = approvalPosts.get(requestId);
    const clicker = args.body?.user?.id;
    // An unknown request predates this daemon or was already settled; the
    // click is answered where it was made, not silently dropped.
    if (!post) {
      await tellClicker(connection, args, 'That approval request is no longer pending.');
      // And the message itself is corrected, so the next person to read it
      // is not offered a decision nothing is waiting for — unless it is
      // one still being posted, which is live with the index simply not
      // caught up yet. Slack can show a message before postMessage
      // resolves here, so a fast click lands inside that window, and
      // stripping its buttons would strand the turn until the approval
      // times out: the record written when the post lands does not put
      // them back. Whether anything has already been written on the
      // message is `retireOrphanedPrompt`'s own question, answered from
      // the message rather than from a memory of it.
      if (!rendering.has(requestId)) {
        await retireOrphanedPrompt(connection, args);
      }
      return;
    }
    // A different agent's app relaying a click would bypass the approver
    // set bound to the request, since each app carries its own.
    if (post.connection !== connection) {
      return;
    }
    if (!fromPrompt(post, args)) {
      await tellClicker(connection, args, NOT_THE_PROMPT);
      return;
    }
    if (!mayDecide(post, clicker)) {
      // The request stays pending: someone who may not decide clicking is
      // not a decision, and consuming the request would let any channel
      // member deny an agent's work.
      await tellClicker(
        connection,
        args,
        `You are not an approver for ${post.agentName}, so that decision was not recorded.`,
      );
      return;
    }

    // The retraction rides on tool.approval-resolved, which the gateway
    // emits from resolveApproval — so a decision and the message showing it
    // cannot disagree, and the timeout path retracts through the same code.
    if (!gateway.resolveApproval({ requestId, answer, actor: clicker })) {
      await tellClicker(connection, args, 'That approval request is no longer pending.');
    }
  };

  const tellClicker = async (
    connection: AgentConnection,
    args: SlackSocketEventArgs,
    text: string,
  ): Promise<void> => {
    const user = args.body?.user?.id;
    const channel = args.body?.channel?.id;
    if (!user || !channel) {
      return;
    }
    const thread = args.body?.message?.thread_ts;
    try {
      await connection.web.chat.postEphemeral({
        channel,
        user,
        text,
        ...(thread ? { thread_ts: thread } : {}),
      });
    } catch (error) {
      warn(`slack: could not send an ephemeral notice: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return { requestCredential, settleCredentialPost, handleInteractive };
};

export type Interactions = ReturnType<typeof createInteractions>;
