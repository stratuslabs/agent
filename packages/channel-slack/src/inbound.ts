/*
 * `handleInbound`: one Slack event, from the socket to a turn. It admits
 * the message, builds what the agent sees (files, earlier context, the
 * room), dispatches the turn and renders the reply, and keeps the message
 * for the next start when the daemon is stopping. Moved out of
 * `createSlackChannelAdapter` in index.ts as is: the statements are
 * unchanged, inside a factory that takes what they closed over there, and
 * the adapter calls it exactly where they were. The one edit:
 * `gatewayRef` is a `let` that `start` sets, so it is read through
 * `getGateway()`. Nothing here is public.
 */

import {
  CONVERSATION_METADATA_KEY,
  type GatewayLike,
  HostRefusalError,
  type ImageAttachment,
  isLatestTurn,
  type JsonObject,
  latestTurnReaction,
  latestTurnReply,
  leastTrusted,
  NO_REPLY_MARKER,
  RunAbortedError,
  SENDER_TRUST_METADATA_KEY,
  senderTrustFor,
  type Session,
  SESSION_TRUST_METADATA_KEY,
  sessionTrustOf,
  type SilentReaction,
  type TrustLevel,
  turnFailureFor,
  turnFilesFor,
  turnReactionFor,
  turnReplyFor,
} from '@stratusagent/core';
import { dispatchKeyFor, NO_REPLY_TEXT, type ReplyOutcome, ReplyRenderer } from './reply.ts';
import {
  attachmentNote,
  createAttachmentSaver,
  type ImagePreview,
  previewNote,
  readImageAttachments,
  readTextAttachments,
  type SavedAttachment,
  savedAttachmentBlocks,
  textAttachmentBlocks,
  type UnreadReasons,
} from './attachments.ts';
import type { AgentConnection } from './connection.ts';
import type { PendingIntake } from './pending-intake.ts';
import { describeSlackError, slackErrorCode } from './slack-errors.ts';
import type { SlackFileFetcher, SlackInboundFile } from './files.ts';
import type { SlackAdapterOptions, SlackInboundEvent, SlackSocketEventArgs } from './index.ts';
import type { ThreadTracking } from './threads.ts';
import type { Admitter } from './admission.ts';

/** Slack's name for each reaction a silent turn may leave (`SILENT_REACTIONS`). */
const SLACK_REACTION_NAMES: Readonly<Record<SilentReaction, string>> = {
  thumbsup: '+1',
  laughing: 'laughing',
  heart: 'heart',
  tada: 'tada',
};

/**
 * Leaves the reaction a reply-optional turn named instead of a reply on
 * the message it was on (card 1078). Never fails the turn, which has
 * already chosen silence: Slack answering `already_reacted` (a redelivered
 * message) is what was wanted, a missing `reactions:write` is said once
 * per app, and any other refusal is said and dropped.
 */
const addSilentReaction = async (
  connection: AgentConnection,
  channel: string,
  timestamp: string,
  reaction: SilentReaction,
  warn: (line: string) => void,
): Promise<void> => {
  const reactions = connection.web.reactions;
  if (!reactions) {
    return;
  }
  try {
    await reactions.add({ channel, timestamp, name: SLACK_REACTION_NAMES[reaction] });
  } catch (error) {
    const code = slackErrorCode(error);
    if (code === 'already_reacted') {
      return;
    }
    if (code === 'missing_scope') {
      if (!connection.reactionWarned.value) {
        connection.reactionWarned.value = true;
        warn(`slack: ${connection.config.agentId}'s Slack app can't add reactions because it lacks the reactions:write scope, so its silent turns leave none. Add it to the app's manifest and reinstall the app.`);
      }
      return;
    }
    warn(`slack: ${connection.config.agentId} could not react to ${timestamp} in ${channel} (${describeSlackError(error)})`);
  }
};

/** What createInbound closes over: values createSlackChannelAdapter owns. */
export interface InboundDeps extends Pick<ThreadTracking, 'rememberAddressee' | 'threadOwner' | 'followUpWinner'>, Pick<Admitter, 'stopTurns' | 'admit'> {
  options: SlackAdapterOptions;
  log: (line: string) => void;
  warn: (line: string) => void;
  editIntervalMs: number;
  fetchFile: SlackFileFetcher;
  fileDownloadTimeoutMs: number;
  now: () => number;
  renderers: Map<string, ReplyRenderer[]>;
  replyOrder: Map<string, Promise<void>>;
  intakeInFlight: Map<string, number>;
  stopsBySession: Map<string, { count: number; by: string }>;
  getGateway: () => GatewayLike | undefined;
  track: (work: Promise<void>) => void;
  pendingKey: (entry: Pick<PendingIntake, 'agentId' | 'team' | 'channel' | 'ts'>) => string;
  replaying: Map<string, { dispatched: boolean; rekept: boolean; refused: boolean; answered: boolean }>;
  noteReplayOutcome: (connection: AgentConnection, channel: string, ts: string, outcome: ReplyOutcome) => ReplyOutcome;
  noteReplayAnsweredAhead: (connection: AgentConnection, channel: string, ts: string) => void;
  keepForNextStart: (entry: PendingIntake) => Promise<boolean>;
  tagsAnAgent: (connection: AgentConnection, text: string) => Promise<boolean>;
  authorFor: (connection: AgentConnection, userId: string) => Promise<string>;
  earlierContext: (connection: AgentConnection, channel: string, thread: string | undefined, before: string, senderTrust: TrustLevel) => Promise<Array<{ message: string; metadata: JsonObject }>>;
  withFilesJustAbove: (connection: AgentConnection, event: SlackInboundEvent & { thread_ts: string }, speaker: string, name: string) => Promise<SlackInboundFile[]>;
  roomFor: (connection: AgentConnection, channel: string, channelType: string | undefined) => Promise<JsonObject | undefined>;
  humanizeMentions: (connection: AgentConnection, text: string) => Promise<string>;
  onIntakeChain: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  overhearReply: (speaker: AgentConnection, channel: string, thread: string, reply: string | (() => string), spoken: Pick<Session, 'metadata'> | (() => Promise<Pick<Session, 'metadata'>>), published: Promise<boolean>) => Promise<void>;
  isStopRequest: (text: string, botUserId: string) => boolean;
  SLACK_STOP_REASON: string;
  RESTARTING_REPLY_TEXT: string;
  STOPPING_REPLY_TEXT: string;
}

export const createInbound = ({
  options,
  log,
  warn,
  editIntervalMs,
  fetchFile,
  fileDownloadTimeoutMs,
  now,
  renderers,
  replyOrder,
  intakeInFlight,
  stopsBySession,
  getGateway,
  track,
  pendingKey,
  replaying,
  noteReplayOutcome,
  noteReplayAnsweredAhead,
  keepForNextStart,
  tagsAnAgent,
  authorFor,
  earlierContext,
  withFilesJustAbove,
  roomFor,
  humanizeMentions,
  onIntakeChain,
  overhearReply,
  isStopRequest,
  SLACK_STOP_REASON,
  RESTARTING_REPLY_TEXT,
  STOPPING_REPLY_TEXT,
  rememberAddressee,
  threadOwner,
  followUpWinner,
  stopTurns,
  admit,
}: InboundDeps) => {
  const handleInbound = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    // Decided before the ack, never after it — see `admit`. That block is
    // map and string work measured in microseconds, against an ack window
    // Slack measures in seconds, and the envelope is acked below whatever
    // the decision was.
    const admitted = admit(connection, args);
    // Acked without awaiting it. The ack still leaves as promptly as it ever
    // did — Slack redelivers unacked envelopes, and a turn outlives the ack
    // window many times over — but nothing here needs its send callback, and
    // awaiting one was the single await between receiving a message and
    // taking its place in the queue below. Two handlers waiting on their
    // acks can come back in either order; two handlers that never wait
    // cannot. A failed ack costs a redelivery, which the dedupe absorbs.
    void Promise.resolve(args.ack()).catch((error) => {
      warn(`slack: could not ack an envelope: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!admitted) {
      return;
    }
    // Re-read rather than carried through the admission: `stop()` can clear
    // it while the ack above is in flight, and a dispatch into a gateway
    // this adapter has let go of is not one to start.
    const gateway = getGateway();
    if (!gateway) {
      return;
    }
    const { event, isDm, team, userId, thread, sessionId, threadKey, eventKey } = admitted;

    // Stop (card 337), see `stopTurns`. Only a message addressed to this
    // agent: an untagged reply this agent merely overhears is the holder's
    // (unless this agent is the holder and only `listens` made it an
    // overhear, see `holderStop`), and one only the sessions can place is
    // not this agent's to act on yet.
    if (
      (!admitted.overhear || admitted.holderStop === true) &&
      admitted.settled &&
      admitted.fromAgent === undefined &&
      (connection.config.approvers ?? []).includes(userId) &&
      isStopRequest(event.text ?? '', connection.botUserId) &&
      stopTurns(connection, sessionId, userId, event.channel)
    ) {
      return;
    }

    // What the gateway knows this message by (see `dispatchKeyFor`).
    const dispatchKey = dispatchKeyFor(eventKey);

    // Everything up to (and including) the dispatch call is serialized per
    // session in Slack receipt order: the user lookups and placeholder
    // post below await network I/O, and without this chain a later message
    // could reach gateway.dispatch first — processing the conversation in
    // reverse order in durable history. The chain is claimed here,
    // synchronously, so a message's place in it is fixed by when Slack
    // delivered it and not by how long anything it does takes.
    const stopsAtClaim = stopsBySession.get(sessionId)?.count ?? 0;
    // Only intake that can still become a turn is something a stop can
    // cancel. A settled overhear that is not judged only ever reaches
    // `gateway.observe`, so counting it would let a stop with nothing to
    // stop be consumed instead of passing on as an ordinary message.
    const mayRun = !admitted.overhear || admitted.judge || !admitted.settled;
    if (mayRun) {
      intakeInFlight.set(sessionId, (intakeInFlight.get(sessionId) ?? 0) + 1);
    }
    let leftIntake = !mayRun;
    const leaveIntake = (): void => {
      if (leftIntake) {
        return;
      }
      leftIntake = true;
      const left = (intakeInFlight.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        intakeInFlight.set(sessionId, left);
      } else {
        intakeInFlight.delete(sessionId);
        stopsBySession.delete(sessionId);
      }
    };
    const intake = onIntakeChain(sessionId, async () => {
      // The durable half of addressing runs INSIDE the chain, for the same
      // reason: it awaits, and a message that had to ask the sessions must
      // not lose its place to one that did not. A message that turns out
      // not to be this agent's leaves an empty link behind, which is all it
      // should cost.
      let overhear = admitted.overhear;
      // Judged, not ruled (card 541): the intake already placed this reply
      // with this agent, so it runs a turn nobody asked for, which may stay
      // quiet. A reply only the sessions can place waits for them below.
      let judged = false;
      if (admitted.judge && admitted.settled) {
        judged = true;
        overhear = false;
      }
      if (!admitted.settled) {
        // One verdict for this message, shared with whichever other agents
        // are asking about it — see `followUpWinner`.
        const stop = (connection.config.approvers ?? []).includes(userId) &&
          isStopRequest(event.text ?? '', connection.botUserId);
        const winner = await followUpWinner(
          {
            team,
            conversation: event.channel,
            thread: event.thread_ts ?? '',
            ...(event.parent_user_id !== undefined ? { parentUser: event.parent_user_id } : {}),
          },
          event.ts,
          stop ? 'stop' : 'reply',
        );
        if (winner !== connection.config.agentId) {
          // Not this agent's to answer — and, if it is in the thread,
          // this agent's to hear, same as the two warm stand-downs. Only a
          // stop sends a judging agent here, and a stop the sessions place
          // with another agent is heard, never judged, as it is warm.
          judged = false;
          overhear = true;
        } else {
          if (admitted.judge) {
            judged = true;
            overhear = false;
          }
          if (threadKey) {
            // Answered from the store rather than from memory: hold it, so
            // the rest of the thread is ordered by receipt like any other.
            rememberAddressee(threadKey, connection.config.agentId, event.ts);
          }
          // Stop (card 337) for a message only the sessions could place:
          // now that they say it is this agent's, it is a stop like the
          // warm one above, not a message to queue behind the turn it stops.
          if (
            (connection.config.approvers ?? []).includes(userId) &&
            isStopRequest(event.text ?? '', connection.botUserId) &&
            stopTurns(connection, sessionId, userId, event.channel, true)
          ) {
            return undefined;
          }
        }
      }
      // One line per decision a judging agent makes on an untagged reply
      // (card 541): whether it took the turn, and why. Never the text.
      if (admitted.judgeReason !== undefined) {
        const reason = admitted.settled || judged ? admitted.judgeReason : 'another agent\'s, from the thread read';
        log(`slack: judge: ${connection.config.agentId} ${judged ? 'took' : 'heard'} ${event.ts} in ${event.channel} (${reason})`);
      }
      // Said to this agent, but possibly needing nothing back (card 601):
      // only for a message this agent answers, and never for a judged one,
      // whose turn already may stay quiet. One line, never the text.
      const replyOptional = admitted.replyOptional === true && !judged && !overhear;
      if (replyOptional) {
        log(`slack: ${connection.config.agentId} took ${event.ts} in ${event.channel} (reply optional: ${admitted.fromAgent !== undefined ? 'agent mention' : 'untagged follow-up'})`);
      }
      const cleaned = await humanizeMentions(connection, event.text ?? '');
      // Fetched inside the chain, like the lookups below: it is network
      // I/O, and a message whose screenshot is slow to arrive must not lose
      // its place to the one typed after it. Only for a message this agent
      // will answer: an overheard one is appended as text with no turn run
      // on it, and its attachments reach the transcript by name, as every
      // attachment did before images.
      // A judged message is one this agent will run a turn on, so its
      // files are read too (card 625): the kernel stores them on the
      // overheard message, and every provider shows the images after the
      // frame that marks it as somebody else's. Text files land inside the
      // message, so the frame quotes them with the rest of it.
      // A team agent's tag inside a thread carries the files its turn posted
      // just above it (card 1061), read as if they were attached to the tag.
      const files = admitted.fromAgent !== undefined && !overhear && event.thread_ts !== undefined && event.thread_ts !== event.ts
        ? await withFilesJustAbove(connection, { ...event, thread_ts: event.thread_ts }, userId, admitted.fromAgent)
        : event.files ?? [];
      // Images and text files share the message's one download deadline.
      const deadline = AbortSignal.timeout(fileDownloadTimeoutMs);
      const reasons: UnreadReasons = new Map();
      if (overhear) {
        for (const file of files) {
          reasons.set(file, 'not-opened');
        }
      }
      const { images, unread: notImages, previews } = overhear
        ? { images: [] as ImageAttachment[], unread: files, previews: [] as ImagePreview[] }
        : await readImageAttachments(
          files,
          connection.config.botToken,
          fetchFile,
          fileDownloadTimeoutMs,
          warn,
          reasons,
          deadline,
        );
      // Text is spent from the first file on, so the tag's own files lead:
      // ones carried from above it (card 1061) must not crowd them out.
      const ownFiles = new Set(event.files ?? []);
      const ownFirst = [...notImages.filter((file) => ownFiles.has(file)), ...notImages.filter((file) => !ownFiles.has(file))];
      const { texts, saved, unread } = overhear
        ? { texts: [], saved: [] as SavedAttachment[], unread: notImages }
        : await readTextAttachments(
          ownFirst,
          connection.config.botToken,
          fetchFile,
          fileDownloadTimeoutMs,
          deadline,
          warn,
          reasons,
          options.attachmentStore
            ? createAttachmentSaver(options.attachmentStore, connection.config.agentId, admitted.fromAgent !== undefined ? 'unknown' : senderTrustFor(connection.config, userId), options.now ?? Date.now)
            : undefined,
        );
      // An image or a document with nothing said is still a question
      // ("what's this?"); a file the turn could not open with nothing said
      // is not one, and gets no reply.
      if (cleaned.length === 0 && images.length === 0 && texts.length === 0 && saved.length === 0) {
        return undefined;
      }
      // A team agent goes by the name the operator gave it, not a profile
      // its own app chose.
      // A team agent's daemon hears only what tags its bot (card 513), so
      // the model gets that tag and decides whether its answer needs it
      // (Dylan, 2026-10-15: the model tags back, the adapter never does).
      const author = admitted.fromAgent !== undefined
        ? `${admitted.fromAgent} (an agent; it sees your answer only if you tag <@${userId}>)`
        : await authorFor(connection, userId);
      // In shared channels the model should know who is speaking; a DM is
      // unambiguous. A bare image in a channel still says who sent it.
      const spoken = isDm ? cleaned : (cleaned.length > 0 ? `${author}: ${cleaned}` : `${author}:`);
      const userMessage = `${spoken}${textAttachmentBlocks(texts)}${savedAttachmentBlocks(saved)}${previewNote(previews)}${attachmentNote(unread, reasons)}`;
      // Who sent this, judged against the operator's list — per message,
      // never remembered from the first one in the thread. A DM proves
      // nothing about who is typing, so a DM from an unlisted member is
      // `unknown` exactly as a channel mention would be. The same label
      // whether the agent answers or only hears: the text is in its
      // transcript either way.
      // A team agent is below a principal whatever the list says: its
      // words carry whatever its own session was exposed to, which nothing
      // here can see (card 513).
      const senderTrust: TrustLevel = admitted.fromAgent !== undefined ? 'unknown' : senderTrustFor(connection.config, userId);
      // Who can read this, so the agent writes for them, and a thread says
      // it is one. A DM names the other person only when they are one of
      // the operator's principals: this lands in the system prompt, and
      // anyone else's display name is text they chose, which a pattern
      // cannot tell from an instruction phrased as a name.
      const room = await roomFor(connection, event.channel, isDm ? 'im' : event.channel_type);
      const conversation = room === undefined
        ? undefined
        : {
          ...room,
          ...(room.kind === 'direct' && senderTrust === 'user' ? { with: author } : {}),
          // A DM thread is a thread too, with its own session; core takes
          // no root for a direct room, since nothing posts to one by id.
          ...(thread !== undefined ? { thread: true, ...(room.kind !== 'direct' ? { threadRoot: thread } : {}) } : {}),
          // People outside this workspace read a Slack Connect channel, and
          // the event says so itself, even when the lookup failed.
          ...(room.kind !== 'direct' && args.body?.is_ext_shared_channel === true ? { shared: true } : {}),
        };
      const metadata = {
        channel: 'slack',
        team,
        slackChannel: event.channel,
        slackUser: userId,
        // Carried so a mid-turn approval question is asked in the thread
        // the turn belongs to rather than at the top of a busy channel.
        ...(thread ? { slackThread: thread } : {}),
        ...(conversation !== undefined ? { [CONVERSATION_METADATA_KEY]: conversation } : {}),
        [SENDER_TRUST_METADATA_KEY]: senderTrust,
      };

      if (overhear) {
        // Heard, not answered: no placeholder, no turn. Only into a
        // conversation this agent is already in — a session under this
        // thread's key exists exactly when it was invited here — and the
        // gateway is the one to say whether it is, on the session's chain:
        // a first mention whose dispatch is queued ahead of this message
        // has created the session by the time the observe runs, where a
        // membership read from here would find nothing and drop a
        // message said moments after the invitation. A host that cannot
        // take it leaves the agent hearing what it answers, as every
        // agent did before.
        if (!gateway.observe) {
          return undefined;
        }
        // Placed on the gateway's chain here, in receipt order, and not
        // awaited here: a dispatch is placed the same way, and awaiting
        // an overhear queued behind a long turn would hold the next
        // message's place in this chain hostage to that turn.
        return {
          observed: gateway.observe({ sessionId, agentId: connection.config.agentId, message: userMessage, metadata }),
        };
      }

      // A turn nobody asked for opens its placeholder on its first text,
      // if it ever has any — see `ReplyRenderer.lazy`. One the agent's
      // reply mode does not stream opens none at all, and shows the
      // loading status instead — see `ReplyRenderer.streaming`.
      // Mentioned into a thread partway: hand the new session what was
      // said before this. Inside the chain, before the placeholder, so the
      // read cannot reorder this message against the next one.
      let earlier: Array<{ message: string; metadata: JsonObject }> = [];
      if (thread !== undefined) {
        // A top-level mention roots its own session, so it is new but for
        // a redelivery, which the gateway answers without reading this.
        let exists = false;
        if (thread !== event.ts && gateway.sessionRouting) {
          try {
            exists = (await gateway.sessionRouting(sessionId)) !== undefined;
          } catch {
            // Unknown is read as new: a session that does exist ignores
            // the list, so the cost of guessing wrong is one API read.
          }
        }
        if (!exists) {
          // A mention that starts its own thread follows the channel; one
          // inside a thread follows that thread.
          earlier = await earlierContext(connection, event.channel, thread === event.ts ? undefined : thread, event.ts, senderTrust);
        }
      }

      const streaming = connection.config.replies === 'stream';
      const ahead = streaming ? undefined : replyOrder.get(sessionId);
      const renderer = new ReplyRenderer(connection.web, event.channel, thread, editIntervalMs, warn, {
        lazy: judged,
        mayStaySilent: replyOptional,
        now,
        streaming,
        texts: connection.config.replies === 'texts',
        tagsAnAgent: (text: string) => tagsAnAgent(connection, text),
        statusThread: thread ?? event.ts,
        statusWarned: connection.statusWarned,
        ...(ahead ? { after: ahead } : {}),
        ...(isDm ? { dmWith: userId } : {}),
        // Each interim message, as it lands, takes its place in the
        // thread's other agents' sessions — ahead of a follow-up typed
        // while the tool it preceded is still running. Under the session's
        // label as stored, lowered by anything that tainted it during this
        // turn, and the least trusted label where it cannot be read.
        // A DM thread has nobody else in it to hear.
        ...(thread !== undefined && !isDm
          ? {
            onInterim: (heard: () => string, landed: Promise<boolean>) => {
              // Tracked, so a shutdown drains it like any other reaction:
              // the text is already in the thread, whatever the turn does.
              track(overhearReply(connection, event.channel, thread, heard, async () => {
                const routed = await gateway.sessionRouting?.(sessionId).catch(() => undefined);
                const stored = routed ? sessionTrustOf(routed) : 'external';
                const live = renderer.taintedTo === undefined ? stored : leastTrusted(stored, renderer.taintedTo);
                return { metadata: { [SESSION_TRUST_METADATA_KEY]: live } };
              }, landed));
            },
          }
          : {}),
      });
      if (!streaming) {
        replyOrder.set(sessionId, renderer.posted);
        void renderer.posted.then(() => {
          if (replyOrder.get(sessionId) === renderer.posted) {
            replyOrder.delete(sessionId);
          }
        });
      }
      if (!judged && streaming) {
        try {
          await renderer.open();
        } catch (error) {
          warn(`could not post to ${event.channel}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      }

      // The push and the dispatch happen in the same microtask, so queue
      // order matches the gateway's single-flight turn order for this
      // session: index 0 is always the turn currently running.
      const queue = renderers.get(sessionId) ?? [];
      queue.push(renderer);
      renderers.set(sessionId, queue);
      // Stopped while its lookups ran: dispatched under an aborted signal,
      // so it ends the way a queued turn a stop reached does.
      const stopped = stopsBySession.get(sessionId);
      leaveIntake();
      if (stopped !== undefined && stopped.count !== stopsAtClaim && renderer.stoppedBy === undefined) {
        renderer.stoppedBy = stopped.by;
        renderer.controller.abort(new RunAbortedError(`${SLACK_STOP_REASON}${stopped.by}`));
      }
      // In a DM each message is its own status key, and Slack stops showing
      // the running turn's once a newer message sits below it — so a
      // message queued there that stayed dark read as the agent having
      // stopped until the reply ahead of it posted. In a channel thread the
      // key is shared, and the running turn's status stays up instead.
      renderer.showLoading(queue.length === 1 || queue[0]?.statusThread !== renderer.statusThread);
      let repeat: 'live' | 'finished' | undefined;
      let absorbed = false;
      const replay = replaying.get(pendingKey({ agentId: connection.config.agentId, team: connection.teamId, channel: event.channel, ts: event.ts }));
      if (replay !== undefined) {
        replay.dispatched = true;
      }
      const turn = gateway.dispatch({
        sessionId,
        agentId: connection.config.agentId,
        userMessage,
        ...(images.length > 0 ? { images } : {}),
        ...(judged ? { addressed: false } : {}),
        ...(replyOptional ? { replyOptional: true } : {}),
        ...(earlier.length > 0 ? { earlier } : {}),
        turnId: renderer.turnId,
        metadata,
        signal: renderer.controller.signal,
        // A redelivery this process no longer remembers (it restarted, or
        // the dedupe evicted it) is still the message it was: the gateway
        // runs no second turn for it, and says so through `onRepeat`.
        idempotencyKey: dispatchKey,
        onRepeat: (kind) => {
          repeat = kind;
        },
        // Sent while a turn is running, this message is answered by the
        // next turn together with everything else that queued (card 423);
        // the first of them renders that answer. Not a replayed message:
        // it leaves the kept list only on its own confirmed answer, and an
        // answer another message's renderer posts is not one it can see.
        ...(replay === undefined
          ? {
            onAbsorbed: () => {
              absorbed = true;
            },
          }
          : {}),
      });
      return { renderer, turn, repeat: () => repeat, absorbed: () => absorbed };
    });

    // Whatever way the intake ended, it is no longer in flight.
    void intake.then(leaveIntake, leaveIntake);
    const started = await intake;
    if (!started) {
      return;
    }
    if ('observed' in started) {
      // Nothing to render; the one outcome worth a line is the host
      // refusing it — a turn parked across a restart, most likely — since
      // a message dropped on the floor is the thing this exists to end.
      try {
        await started.observed;
      } catch (error) {
        warn(`slack: ${connection.config.agentId} could not overhear a message in ${event.channel}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const { renderer, turn, repeat, absorbed } = started;

    const removeFromQueue = (): void => {
      const current = renderers.get(sessionId);
      if (current) {
        const index = current.indexOf(renderer);
        if (index >= 0) {
          current.splice(index, 1);
        }
        if (current.length === 0) {
          renderers.delete(sessionId);
        }
      }
    };

    let session: Session | undefined;
    let failure: unknown;
    try {
      session = await turn;
    } catch (error) {
      failure = error;
    }
    // The next queued turn starts the moment this dispatch settles — its
    // events must reach ITS renderer, so this one leaves the queue BEFORE
    // the potentially slow final edit, uploads, and overflow posts.
    removeFromQueue();

    // The turn is a live earlier delivery's, and that delivery's renderer
    // posts its answer, or its failure: this one takes down whatever it put
    // up and says nothing.
    // Likewise a message absorbed into a merged turn: the turn's leading
    // message's renderer answers for all of them.
    if (repeat() === 'live' || absorbed()) {
      // A replayed message whose turn the start-up recovery owns is
      // answered by that recovery's report, and only if it reached the
      // thread; anything else leaves it kept.
      const ahead = repeat() === 'live' && renderer.outcomeReportedAhead !== undefined
        ? await renderer.outcomeReportedAhead
        : undefined;
      if (ahead?.said === true) {
        noteReplayAnsweredAhead(connection, event.channel, event.ts);
      }
      await renderer.withdraw();
      renderers.get(sessionId)?.[0]?.refreshLoading();
      return;
    }
    // A finished one's outcome is posted here, because nothing says the
    // delivery that ran it lived to post it, and no event will carry its
    // files: they are read from the session, like its reply below.
    //
    // Less what the start-up sweep already said, when it finished this
    // message's turn while the redelivery waited behind it: that outcome
    // was reported ahead of this renderer as a turn nobody was rendering,
    // and posting it again would say it twice. It was this message's turn
    // if it is the session's latest — anything finished after it would be
    // the latest instead — and the report says, part by part, what reached
    // the thread: the files it landed are not posted again, and the text
    // only if it was not said in full.
    const finished = repeat() === 'finished';
    const reportedAhead = session && finished && renderer.outcomeReportedAhead !== undefined && isLatestTurn(session, dispatchKey)
      ? await renderer.outcomeReportedAhead
      : undefined;
    if (session && finished) {
      // Counted, not a set: a turn can produce one path twice, and each
      // result is an upload of its own, so one landing does not cover both.
      const landed = new Map<string, number>();
      for (const filePath of reportedAhead?.landed ?? []) {
        landed.set(filePath, (landed.get(filePath) ?? 0) + 1);
      }
      renderer.queueFiles(turnFilesFor(session, dispatchKey).filter((file) => {
        const left = landed.get(file.path) ?? 0;
        if (left > 0) {
          landed.set(file.path, left - 1);
          return false;
        }
        return true;
      }));
    }
    if (reportedAhead?.said === true) {
      noteReplayAnsweredAhead(connection, event.channel, event.ts);
      await renderer.withdraw();
      renderers.get(sessionId)?.[0]?.refreshLoading();
      return;
    }

    // A dispatch whose turn fails rejects, but one that repeats a turn that
    // already failed — or continues a crashed one the gateway could only
    // fail — resolves with the failed session. Its failure is posted as the
    // original delivery's would have been, not as a reply that says nothing.
    const failedWith = session ? turnFailureFor(session, dispatchKey) : undefined;
    if (failedWith !== undefined) {
      failure = new Error(failedWith);
      session = undefined;
    }

    if (session) {
      // The reply is final here, so this is when the thread's other agents
      // take their place for it — before the final edit and the overflow
      // posts, which are network I/O a later message must not overtake.
      // A DM has no thread, and nobody else in it.
      // A finished repeat's session may have moved on since; its own turn
      // is found by the key.
      const reply = finished ? turnReplyFor(session, dispatchKey) : latestTurnReply(session);
      // A turn nobody asked for that said nothing posts nothing; every
      // other turn says `(no reply)` where its answer would have gone — one
      // rule with the gateway's `sessionRouting`, which posts the same
      // message for a turn this adapter did not start.
      const finalized = renderer.finalize(renderer.lazy || renderer.mayStaySilent ? reply ?? '' : reply ?? NO_REPLY_TEXT);
      // A turn that owed an answer and gave only the word a turn that may
      // stay quiet says nothing with: posted as said, and counted, so how
      // often it happens is known before anything heavier is built.
      if (!renderer.lazy && !renderer.mayStaySilent && reply?.trim() === NO_REPLY_MARKER) {
        log(`slack: ${connection.config.agentId} answered NO_REPLY on a turn that owes an answer (${event.ts} in ${event.channel})`);
      }
      // What the turn said along the way as well as its reply: interim
      // messages are in the thread, so they are in what the others hear.
      // Heard once the posts have settled, and the reply only if it landed:
      // interim messages already in the thread are heard either way.
      let replyLanded = false;
      const settled = finalized.then((outcome) => {
        noteReplayOutcome(connection, event.channel, event.ts, outcome);
        replyLanded = outcome.published;
        return true;
      }, () => true);
      const heard = thread !== undefined && !isDm
        ? overhearReply(connection, event.channel, thread, () => renderer.spokenText(replyLanded ? reply ?? '' : ''), session, settled)
        : undefined;
      const { spoke, spokeAt } = await finalized;
      // A reply-optional turn that said nothing may have named a reaction
      // to leave instead (card 1078), and it goes on this message only if
      // nothing of the turn's reached the thread.
      if (renderer.mayStaySilent && !spoke && (reply ?? '').trim().length === 0) {
        const reaction = finished ? turnReactionFor(session, dispatchKey) : latestTurnReaction(session);
        if (reaction !== undefined) {
          await addSilentReaction(connection, event.channel, event.ts, reaction, warn);
        }
      }
      if (spoke && threadKey !== undefined) {
        // The voice that just answered, recorded where its reply sits in
        // the thread. For a judging agent this is the only record there
        // is — it took no part in the holder rule at intake — and without
        // it a thread-rule colleague that held the thread before would
        // keep answering beside it. For any other turn the intake wrote
        // one at the message answered, and this one says where the answer
        // landed, which is what settles two turns running at once: a
        // placeholder posted at intake sits above a reply a judge posted
        // while it was being filled, whichever turn finished first, and
        // the reader's next untagged message is for the lower of the two.
        // Late, either way, for a message typed while the turn was still
        // running, which the other may therefore still take.
        // Under the owner rule (card 508) only two replies move the thread:
        // a judging agent that chose to speak, and the owner answering in
        // its own thread, which takes it back from a judge that spoke above.
        // An answer to a mention is that message's answer and no more.
        const takes = renderer.lazy || threadOwner(threadKey) === connection.config.agentId;
        rememberAddressee(threadKey, connection.config.agentId, spokeAt ?? event.ts, takes);
      }
      // The reply just posted took the thread's status down with it, and a
      // turn queued behind this one is still working.
      renderers.get(sessionId)?.[0]?.refreshLoading();
      await heard;
    } else {
      // A paused daemon's refusal is its answer, said as it is: the
      // operator wrote that sentence for the person reading it, and it is
      // not a failure of the agent. Matched by name, as this package does
      // not import the gateway. A turn nobody asked for stays silent.
      const pausedReply = failure instanceof Error && failure.name === 'IntakePausedError';
      // A daemon on its way down that still heard this (the gateway keeps
      // channels connected through its drain): the message is kept for the
      // next start, which handles it as if it had just arrived. Said only
      // to a message that asked: a judged reply in the agent's thread (a
      // turn nobody asked for) is kept so the next daemon can still judge
      // it, but nobody asked, so a notice under it would be noise. An
      // overheard message never gets here; it was never going to be a turn.
      // Matched by name, like the pause.
      const stoppingRefusal = failure instanceof Error && failure.name === 'GatewayStoppingError' && renderer.stoppedBy === undefined;
      let deferredText: string | undefined;
      if (stoppingRefusal) {
        const restarting = (failure as Error & { restarting?: unknown }).restarting !== false;
        const kept = await keepForNextStart({
          agentId: connection.config.agentId,
          team,
          channel: event.channel,
          ts: event.ts,
          ...(event.thread_ts !== undefined ? { threadTs: event.thread_ts } : {}),
          user: userId,
          ...(event.channel_type !== undefined ? { channelType: event.channel_type } : {}),
          keptAt: now(),
        });
        if (kept) {
          log(`slack: ${connection.config.agentId} kept ${event.ts} in ${event.channel} to answer after the ${restarting ? 'restart' : 'stop'}`);
          deferredText = restarting ? RESTARTING_REPLY_TEXT : STOPPING_REPLY_TEXT;
        } else {
          deferredText = (failure as Error).message;
        }
      }
      // A refusal (paused, or a daemon on its way down) ran no turn, so its
      // notice is never what answers a replayed message: that one stays
      // kept, whether or not keeping it again just worked.
      const refused = pausedReply || stoppingRefusal;
      const outcome = renderer.stoppedBy !== undefined
        ? await renderer.stopped(renderer.stoppedBy)
        : refused
        ? await renderer.finalize(renderer.lazy ? '' : deferredText ?? (failure as Error).message)
        : await renderer.fail(failure instanceof Error ? failure.message : String(failure), failure instanceof HostRefusalError);
      const { spoke, spokeAt } = refused && renderer.stoppedBy === undefined
        ? outcome
        : noteReplayOutcome(connection, event.channel, event.ts, outcome);
      if (spoke && threadKey !== undefined) {
        // A file it posted before breaking has still spoken, by the same
        // rule as a reply that landed.
        const takes = renderer.lazy || threadOwner(threadKey) === connection.config.agentId;
        rememberAddressee(threadKey, connection.config.agentId, spokeAt ?? event.ts, takes);
      }
      renderers.get(sessionId)?.[0]?.refreshLoading();
    }
  };

  return { handleInbound };
};

export type Inbound = ReturnType<typeof createInbound>;
