/*
 * Admission: whether a Slack message is for an agent here, and handing it
 * over. Stopping a thread's turns, agent-to-agent mentions and their hop
 * limit, and `admit`, which decides who answers. Moved out of
 * `createSlackChannelAdapter` in index.ts as is: the statements are
 * unchanged, inside a factory that takes what they closed over there, and
 * the adapter calls it exactly where they were. The one edit:
 * `gatewayRef` is a `let` that `start` sets, so it is read through
 * `getGateway()`. Nothing here is public.
 */

import {
  admitsSender,
  channelSessionKey,
  type GatewayLike,
  type ListensMode,
  RunAbortedError,
} from '@stratusagent/core';
import { neutralizeMentions } from './posts.ts';
import type { ReplyRenderer } from './reply.ts';
import type { AgentConnection } from './connection.ts';
import type { SlackAgentConfig, SlackInboundEvent, SlackSocketEventArgs } from './index.ts';
import type { ThreadTracking } from './threads.ts';

/**
 * Message subtypes that are another agent's bot speaking (card 513): a plain
 * bot post, an upload with a comment, or a thread reply also sent to the
 * channel. Edits, deletions and joins are never a mention to answer.
 */
const AGENT_SPEECH_SUBTYPES = new Set(['bot_message', 'file_share', 'thread_broadcast']);

/**
 * A message `admit` has decided is this agent's, and everything it worked
 * out on the way — so the async half neither re-derives nor re-reads any of
 * it. `settled: false` is the one open question left: whether the sessions
 * say this untagged reply is ours.
 */
interface Admission {
  event: SlackInboundEvent;
  isDm: boolean;
  team: string;
  userId: string;
  sessionId: string;
  thread?: string;
  /** Absent for a DM, which has one agent by construction. */
  threadKey?: string;
  /**
   * The key the message is known by whichever delivery carried it — the
   * dedupe key, and the dispatch's idempotency key, so a redelivery the
   * in-memory dedupe has forgotten (a restart, an eviction) still starts
   * no second turn.
   */
  eventKey: string;
  settled: boolean;
  /**
   * In the thread, if at all, as a listener: the message is somebody
   * else's to answer, and this agent hears it into its session rather than
   * replying. Decided here for the two cases the process can settle
   * synchronously — a message naming another agent, and one an earlier
   * handover gave to another agent — and by the sessions for the cold one.
   */
  overhear: boolean;
  /**
   * An untagged message reaching an agent that judges (`listens: judge`)
   * that is this agent's to judge (card 541): the person last addressed it
   * by name, or else it owns the thread. It runs a turn nobody asked for,
   * which may stay quiet. With `settled: false` only the sessions can say
   * whose the thread is, and the intake decides.
   */
  judge: boolean;
  /** Why a judging agent took or left an untagged reply, for the log line. No message text. */
  judgeReason?: string;
  /**
   * An approver's untagged stop in a thread this agent holds, reaching an
   * agent that listens to mentions or judges (card 337). Still heard if
   * nothing is running to stop, but if something is, it stops it: the
   * holder rule is what makes an untagged stop this agent's, whatever
   * `listens` says about ordinary replies.
   */
  holderStop?: boolean;
  /**
   * The team agent this message came from, when another agent's bot named
   * this one (card 513). Its words are labelled `unknown`, and it is never
   * a stop or an approver's reply.
   */
  fromAgent?: string;
  /**
   * Said to this agent, but possibly needing no answer (card 601): another
   * agent's tagged message, or a person's untagged follow-up in a thread
   * this agent holds on the `thread` rule. Dispatched `replyOptional`, and
   * rendered like a judged turn — nothing posted until it speaks, and a
   * turn that says nothing leaves the thread untouched — except that a
   * failure still says so. A direct mention or a DM never carries it.
   */
  replyOptional?: boolean;
}

/** What createAdmitter closes over: values createSlackChannelAdapter owns. */
export interface AdmitterDeps extends Pick<ThreadTracking, 'threadKeyFor' | 'rememberAddressee' | 'stopHolderAt' | 'holderAt' | 'noteThreadStart' | 'noteForeignSpeaker' | 'agentNamedIn' | 'followUpWinner'> {
  log: (line: string) => void;
  renderers: Map<string, ReplyRenderer[]>;
  intakeInFlight: Map<string, number>;
  stopsBySession: Map<string, { count: number; by: string }>;
  rememberSenderAddressee: (key: string, sender: string, agentId: string, ts: string) => void;
  senderAddresseeAt: (key: string, sender: string, ts: string) => string | undefined;
  replyTargetAt: (key: string, sender: string, ts: string) => string | undefined;
  botIdentities: Map<string, { botUserId: string; teamId: string }>;
  getGateway: () => GatewayLike | undefined;
  track: (work: Promise<void>) => void;
  alreadySeen: (key: string) => boolean;
  agentConfigFor: (agentId: string) => SlackAgentConfig | undefined;
  homeOwners: Map<string, string>;
  listensOf: (agentId: string) => ListensMode;
  SLACK_STOP_REASON: string;
  mentions: (text: string, botUserId: string) => boolean;
  AGENT_MENTION_HOP_LIMIT: number;
  AGENT_MENTION_HOP_WINDOW_MS: number;
  warn: (line: string) => void;
  now: () => number;
  THREAD_ADDRESSEE_CAPACITY: number;
  isPersonSpeaking: (event: SlackInboundEvent) => boolean;
  compareSlackTs: (left: string, right: string) => number;
  isStopRequest: (text: string, botUserId: string) => boolean;
}

export const createAdmitter = ({
  log,
  renderers,
  intakeInFlight,
  stopsBySession,
  rememberSenderAddressee,
  senderAddresseeAt,
  replyTargetAt,
  botIdentities,
  getGateway,
  track,
  alreadySeen,
  agentConfigFor,
  homeOwners,
  listensOf,
  SLACK_STOP_REASON,
  mentions,
  AGENT_MENTION_HOP_LIMIT,
  AGENT_MENTION_HOP_WINDOW_MS,
  warn,
  now,
  THREAD_ADDRESSEE_CAPACITY,
  isPersonSpeaking,
  compareSlackTs,
  isStopRequest,
  threadKeyFor,
  rememberAddressee,
  stopHolderAt,
  holderAt,
  noteThreadStart,
  noteForeignSpeaker,
  agentNamedIn,
  followUpWinner,
}: AdmitterDeps) => {
  /**
   * Everything about who a message is for that can be decided WITHOUT
   * AWAITING, run straight off the socket's own event emission — so for the
   * whole of it, this process is exactly as far through the conversation as
   * Slack is.
   *
   * That is the point of it being one synchronous block. The Socket Mode
   * client emits envelopes in order, but `ack()` resolves from a WebSocket
   * send callback, so two handlers that ack before deciding anything can
   * come back in either order: a follow-up could then overtake the mention
   * that opened its thread, find neither a record nor a session, and be
   * dropped for good. Nothing here awaits, so nothing can be overtaken —
   * the dedupe and the handover record included, which are the two pieces a
   * later message reads.
   *
   * `undefined` means the message is nothing to this agent — a DM to
   * someone else, the room rather than a thread, its own words.
   * `overhear: true` means it is somebody else's to answer and this
   * agent's to hear, if it is in the thread at all, which only the sessions
   * can say. `settled: false` means only the sessions can decide even that
   * much, which is the one case that has to wait — and it is the cold
   * case, where by definition no message of this thread has been seen in
   * this process.
   */
  /**
   * Stop (card 337): cancels every turn this agent is running or has queued
   * in this conversation, including messages still in intake, and says
   * nothing was stopped when there was nothing to stop. Synchronous, and
   * called off the intake chain before any dispatch, so a stop is never
   * queued behind the turn it stops nor merged into the next one. The
   * caller has checked that the sender is an approver: a stop throws away
   * work someone else asked for.
   *
   * `fromIntake` is a stop that could only be placed on the intake chain,
   * once the sessions named this agent (the cold case). Everything ahead of
   * it on the chain has already been dispatched, and everything still in
   * intake arrived after it, so it cancels the dispatched turns only.
   *
   * It also stops the background tasks this conversation started (AGT-357,
   * decision 3 of agent-plans roadmap/952-background-tasks.md): a person
   * who says stop means those too. Tasks alone make it a stop, and once
   * their stops are written one line in `thread` names them.
   */
  const stopTurns = (
    connection: AgentConnection,
    sessionId: string,
    userId: string,
    channel: string,
    thread: string | undefined,
    fromIntake = false,
  ): boolean => {
    const running = renderers.get(sessionId) ?? [];
    const inIntake = fromIntake ? 0 : intakeInFlight.get(sessionId) ?? 0;
    const reason = `${SLACK_STOP_REASON}${userId}`;
    for (const renderer of running) {
      if (renderer.stoppedBy === undefined) {
        renderer.stoppedBy = userId;
        renderer.controller.abort(new RunAbortedError(reason));
      }
    }
    // Also a turn no renderer of this process started (card 501): one the
    // gateway recovered after a restart, or another caller's on this
    // session. The gateway counts every turn still on the session, one
    // already stopping included, so a repeated stop while a stopped turn
    // winds down is still a stop, and once it has ended, however it ended,
    // a stop with nothing running is an ordinary message. The renderers'
    // started turns are among those counted.
    const onSession = getGateway()?.abortTurns?.(sessionId, reason) ?? 0;
    // Counted at once, like the turns, so a stop with only tasks running is
    // still a stop and never a message to the agent. A task an earlier stop
    // reached that hasn't ended yet still counts, and isn't named again.
    const tasks = getGateway()?.stopTasks?.(sessionId, userId);
    const openTasks = tasks?.open ?? 0;
    if (running.length === 0 && inIntake === 0 && onSession === 0 && openTasks === 0) {
      return false;
    }
    if (tasks !== undefined && openTasks > 0) {
      track(tasks.stopped.then(async (stopped) => {
        if (stopped.length === 0) {
          return;
        }
        const named = stopped.map((id) => `\`${id}\``).join(', ');
        await connection.web.chat.postMessage({
          channel,
          text: `Stopped by <@${userId}>: background task${stopped.length === 1 ? '' : 's'} ${named}.`,
          ...(thread !== undefined ? { thread_ts: thread } : {}),
        });
      }).catch((error: unknown) => {
        log(`slack: could not say which background tasks ${userId} stopped in ${channel}: ${error instanceof Error ? error.message : String(error)}`);
      }));
    }
    if (inIntake > 0) {
      stopsBySession.set(sessionId, { count: (stopsBySession.get(sessionId)?.count ?? 0) + 1, by: userId });
    }
    // A renderer's started turn is also one the gateway counts, so this is
    // the larger of the two, not their sum.
    const taskCount = openTasks > 0 ? ` and ${openTasks} background task(s)` : '';
    log(`slack: ${userId} stopped ${Math.max(running.length, onSession) + inIntake} turn(s)${taskCount} of ${connection.config.agentId} in ${channel}`);
    return true;
  };

  /**
   * Agent mentions admitted per thread, then per agent they named (card
   * 513, AGT-366): each agent here has its own count, so one busy pair in a
   * thread can't silence another agent there. A hop is the message ts, so a
   * copy of one message reaching a second socket, or redelivered, is the
   * same hop, and when it was admitted: only hops admitted in the last
   * `AGENT_MENTION_HOP_WINDOW_MS` count. A person an agent admits speaking
   * in the thread clears that agent's hops from before their message.
   * `noticedAt` is when the agent last said in the thread that it skipped
   * a tag, so it says so once a window. Bounded like the addressee map.
   */
  const agentHops = new Map<string, Map<string, { hops: Array<{ ts: string; at: number }>; noticedAt?: number }>>();
  const hopWindowMinutes = Math.round(AGENT_MENTION_HOP_WINDOW_MS / 60_000);

  /**
   * The line an agent posts in a thread when it skips a tag at its hop
   * limit. It names nobody, so it can't start anyone's turn: a configured
   * team agent name is any string, so Slack markup in it is neutralized.
   */
  const hopLimitNotice = (from: string, reopensInMinutes: number): string => neutralizeMentions(
    `I'm skipping ${from}'s tag: agents have tagged me ${AGENT_MENTION_HOP_LIMIT} times in this thread in the last ${hopWindowMinutes} minutes, which is my limit for agent tags. `
    + `I'll answer agent tags here again in ${reopensInMinutes} minute${reopensInMinutes === 1 ? '' : 's'}, or as soon as a person posts in this thread.`,
  );

  /**
   * Which team agent a bot user in `team` is, for the agent configured by
   * `config` in workspace `agentTeam`, if any. A configured id counts only
   * in that agent's own workspace: user ids are unique per workspace, so the
   * same id elsewhere is some other bot.
   */
  const teamAgentFor = (config: SlackAgentConfig, agentTeam: string | undefined, team: string, botUser: string): string | undefined => {
    for (const [agentId, identity] of botIdentities) {
      if (identity.teamId === team && identity.botUserId === botUser) {
        return agentId;
      }
    }
    if (agentTeam === undefined || agentTeam !== team) {
      return undefined;
    }
    for (const [name, id] of Object.entries(config.agentMentions?.team ?? {})) {
      if (id === botUser) {
        return name;
      }
    }
    return undefined;
  };

  /**
   * Whether `agentId` answers a mention from `botUser` in `team`: it has
   * agent mentions on, the bot is a team agent to it, and on its list if it
   * keeps one. The hop limit is not asked here.
   */
  const answersAgentMention = (agentId: string, team: string, botUser: string): boolean => {
    const config = agentConfigFor(agentId);
    const settings = config?.agentMentions;
    if (!config || !settings) {
      return false;
    }
    const name = teamAgentFor(config, botIdentities.get(agentId)?.teamId, team, botUser);
    return name !== undefined && (settings.only === undefined || settings.only.includes(name));
  };

  /**
   * A message another agent's bot posted, for an agent that answers team
   * agents (`agentMentions`, card 513). Admitted only when it names this
   * agent, comes from a team agent this one listens to, and the thread is
   * under its hop limit; anything else from a bot is dropped, as every
   * bot message was before. Never part of the holder rule: a bot naming an
   * agent asks it one thing, and hands it nothing.
   */
  const admitAgentMention = (connection: AgentConnection, args: SlackSocketEventArgs): Admission | undefined => {
    const event = args.event;
    const settings = connection.config.agentMentions;
    if (!settings || !event || event.user === undefined || event.user === connection.botUserId) {
      return undefined;
    }
    if ((event.type !== 'app_mention' && event.type !== 'message') || event.channel_type === 'im') {
      return undefined;
    }
    if (event.subtype !== undefined && !AGENT_SPEECH_SUBTYPES.has(event.subtype)) {
      return undefined;
    }
    const text = event.text ?? '';
    if (!mentions(text, connection.botUserId)) {
      return undefined;
    }
    const team = args.body?.team_id ?? connection.teamId;
    const name = teamAgentFor(connection.config, connection.teamId, team, event.user);
    if (name === undefined) {
      return undefined;
    }
    const eventKey = `${connection.config.agentId}:${event.channel}:${event.ts}`;
    if (settings.only !== undefined && !settings.only.includes(name)) {
      if (!alreadySeen(eventKey)) {
        log(`slack: ${connection.config.agentId} ignored a mention from agent ${name}: not on its agent mention list`);
      }
      return undefined;
    }
    const thread = event.thread_ts ?? event.ts;
    const threadKey = threadKeyFor({ team, conversation: event.channel, thread });
    const agentId = connection.config.agentId;
    const at = now();
    const byAgent = agentHops.get(threadKey) ?? new Map<string, { hops: Array<{ ts: string; at: number }>; noticedAt?: number }>();
    const counted = byAgent.get(agentId);
    const hops = (counted?.hops ?? []).filter((hop) => at - hop.at < AGENT_MENTION_HOP_WINDOW_MS);
    if (!hops.some((hop) => hop.ts === event.ts)) {
      if (hops.length >= AGENT_MENTION_HOP_LIMIT) {
        byAgent.set(agentId, { ...counted, hops });
        if (!alreadySeen(eventKey)) {
          const reopensIn = Math.max(1, Math.ceil((Math.min(...hops.map((hop) => hop.at)) + AGENT_MENTION_HOP_WINDOW_MS - at) / 60_000));
          warn(`slack: ${agentId} ignored a mention from agent ${name}: it has taken ${AGENT_MENTION_HOP_LIMIT} agent mentions in this thread in the last ${hopWindowMinutes} minutes, its hop limit; it answers agents there again in ${reopensIn} min, or once a person speaks there`);
          // Said in the thread too, once a window, so the agent that tagged
          // it (and anyone reading) can see why there's no answer.
          if (counted?.noticedAt === undefined || at - counted.noticedAt >= AGENT_MENTION_HOP_WINDOW_MS) {
            byAgent.set(agentId, { hops, noticedAt: at });
            track(connection.web.chat.postMessage({ channel: event.channel, thread_ts: thread, text: hopLimitNotice(name, reopensIn) }).then(
              () => undefined,
              (error: unknown) => {
                warn(`slack: ${agentId} could not say in ${event.channel} that it skipped a mention from agent ${name}: ${error instanceof Error ? error.message : String(error)}`);
              },
            ));
          }
        }
        return undefined;
      }
      byAgent.set(agentId, { ...counted, hops: [...hops, { ts: event.ts, at }] });
      agentHops.delete(threadKey);
      agentHops.set(threadKey, byAgent);
      if (agentHops.size > THREAD_ADDRESSEE_CAPACITY) {
        const oldest = agentHops.keys().next();
        if (!oldest.done) {
          agentHops.delete(oldest.value);
        }
      }
    }
    if (alreadySeen(eventKey)) {
      return undefined;
    }
    return {
      event,
      isDm: false,
      team,
      eventKey,
      userId: event.user,
      sessionId: channelSessionKey({ channel: 'slack', agentId: connection.config.agentId, team, conversation: event.channel, thread }),
      thread,
      threadKey,
      settled: true,
      overhear: false,
      judge: false,
      fromAgent: name,
      replyOptional: true,
    };
  };

  const admit = (connection: AgentConnection, args: SlackSocketEventArgs): Admission | undefined => {
    const event = args.event;
    if (getGateway()) {
      noteThreadStart(connection, args);
      noteForeignSpeaker(connection, args);
    }
    if (getGateway() && event && (event.bot_id !== undefined || event.subtype === 'bot_message')) {
      return admitAgentMention(connection, args);
    }
    if (event && event.user !== undefined && event.channel_type !== 'im' && isPersonSpeaking(event)) {
      // A person speaking in a thread ends each run of agent mentions there
      // for the agents that admit them, judged on each agent's own terms
      // whichever socket heard it: someone an agent refuses can't restart
      // its run. Only hops before the person's message reset: another
      // agent's socket can deliver an older human message late, after
      // newer hops.
      const sender = event.user;
      const hopKey = threadKeyFor({ team: args.body?.team_id ?? connection.teamId, conversation: event.channel, thread: event.thread_ts ?? event.ts });
      const byAgent = agentHops.get(hopKey);
      if (byAgent) {
        for (const [agentId, counted] of byAgent) {
          if (!admitsSender(agentConfigFor(agentId), sender)) {
            continue;
          }
          const newer = counted.hops.filter((hop) => compareSlackTs(hop.ts, event.ts) > 0);
          if (newer.length > 0) {
            byAgent.set(agentId, { ...counted, hops: newer });
          } else {
            byAgent.delete(agentId);
          }
        }
        if (byAgent.size === 0) {
          agentHops.delete(hopKey);
        }
      }
    }
    if (!getGateway() || !event || !event.user || event.bot_id || !isPersonSpeaking(event)) {
      return undefined;
    }
    if (event.type !== 'app_mention' && event.type !== 'message') {
      return undefined;
    }
    if (event.user === connection.botUserId) {
      return undefined;
    }
    // Bound once the guard above has run: the closures below cannot see
    // that narrowing.
    const sender = event.user;

    const isDm = event.channel_type === 'im';
    const team = args.body?.team_id ?? connection.teamId;
    // A top-level mention has no thread_ts; its own ts roots the reply
    // thread that becomes the conversation. A DM's top level is one
    // conversation per peer, unkeyed by thread; a thread inside the DM is a
    // conversation of its own, answered in that thread.
    const thread = isDm ? event.thread_ts : event.thread_ts ?? event.ts;
    // Threads only: a DM has one agent by construction.
    const threadKey = thread !== undefined && !isDm
      ? threadKeyFor({ team, conversation: event.channel, thread })
      : undefined;

    const text = event.text ?? '';
    const mentioned = isDm || mentions(text, connection.botUserId);

    // Who this message hands the thread to — worked out by EVERY connection
    // that sees it, not only by the one being named, and recorded before any
    // of the rejections below. Each agent is its own Socket Mode connection,
    // so the message naming Bea reaches Ava's socket and Bea's socket
    // independently and in no fixed order; if only Bea recorded the
    // handover, Ava could take the next untagged reply while Bea's socket
    // was still behind, and answer a question that had just been handed
    // away. The message Ava must record is exactly the one Ava ignores.
    // Who the message is for, judged on the named agents' own terms rather
    // than this one's: agents may list different principals, and a sender
    // Ava admits but Bea refuses must not be able to hand Bea the thread
    // from Ava's socket — Bea's own socket refuses the same message, and
    // the map is shared. A message naming Bea and Cy is Cy's, who will
    // answer it and hold the thread. One naming only agents that refuse
    // the sender is still theirs and not this agent's to answer — so the
    // refusing agent stays `named`, and only the handover is withheld.
    // Judged on configuration, not on a live connection: an agent whose
    // socket failed to start is still recognizable in a mention, and its
    // door is still its own. One this adapter was never configured for has
    // no policy, and nobody's to refuse here, so it admits.
    const handoverTo = agentNamedIn(text, team, (agentId) => admitsSender(agentConfigFor(agentId), sender));
    const named = handoverTo ?? agentNamedIn(text, team);
    // A new top-level message in this agent's home channel is addressed to
    // it as surely as a mention would be — unless it names somebody else,
    // which hands it to them exactly as it would anywhere. Top-level only:
    // inside a thread the soul's `listens` already says what an untagged
    // reply is, and the home channel does not overrule it.
    const homeOwner = !isDm && event.thread_ts === undefined && named === undefined
      ? homeOwners.get(`${team}:${event.channel}`)
      : undefined;
    const addressed = mentioned || homeOwner === connection.config.agentId;
    // The key one Slack MESSAGE is known by, whichever delivery carried
    // it; see the dedupe below for why it is not the event id.
    const eventKey = `${connection.config.agentId}:${event.channel}:${event.ts}`;

    // Recorded ahead of this agent's own refusal below, and on the named
    // agent's admission rather than this one's: a sender Ava refuses and
    // Bea admits has handed Bea the thread, and Ava's socket may be the
    // one that hears it first. If Ava withheld the record, a fast untagged
    // follow-up from someone Ava does admit would go to the old holder on
    // Ava's socket and to Bea once Bea's socket caught up — two answers to
    // one message. The refused message itself still takes no place in
    // Ava's transcript; only the map learns who holds the thread.
    if (threadKey && handoverTo) {
      rememberAddressee(threadKey, handoverTo, event.ts);
      rememberSenderAddressee(threadKey, sender, handoverTo, event.ts);
    }
    // A home-channel message hands its new thread to the channel's owner
    // the way a mention would, and is recorded by every socket for the same
    // reason: a reply in that thread can reach another agent's socket before
    // the owner's first turn has written any session routing, and without
    // this record every agent would stand down and the reply would be lost.
    // On the owner's admission, as a handover is.
    if (threadKey && homeOwner !== undefined && admitsSender(agentConfigFor(homeOwner), sender)) {
      rememberAddressee(threadKey, homeOwner, event.ts);
    }

    // Who may speak at all, judged before anything below remembers this
    // message. The adapter's own checks establish nothing about who is
    // typing; under `admit: 'principals'` the operator's list is the door,
    // not a label, and a sender not on it gets neither a turn nor a place
    // in a transcript the agent reads — nor a say in who holds the thread
    // beyond what the named agent's own admission above allowed.
    // Logged rather than answered — a reply is a conversation with someone
    // the operator chose not to have one with — and logged only for a
    // message this agent would have taken up: a mention, or an untagged
    // reply inside a thread this agent is known to hold. A channel
    // subscribed for thread follow-through delivers every post and every
    // reply in every thread, including the threads this agent was never
    // part of, and a line per stranger per reply is a log with nothing
    // left to read. Known from what this process has seen, as the
    // admitted path below judges it; a thread nothing here remembers is
    // one the sessions would have to be asked about, and a refused message
    // does not get a place in that queue. Once per MESSAGE, on the same key
    // the admitted path dedupes on: a mention arrives twice under both
    // subscriptions, and a delivery Slack did not see acknowledged arrives
    // again, and each copy would otherwise write its own line during
    // exactly the traffic an operator reads the log to understand.
    // Consuming the key here is safe because a refused message records
    // nothing a later copy could be needed for.
    if (!admitsSender(connection.config, sender)) {
      // An approver the operator did not list as a principal can still stop
      // the agent (card 337): approving is its own grant. Only when the
      // message names this agent (or is a DM to it), and nothing else they
      // say gets through.
      if (
        addressed &&
        (connection.config.approvers ?? []).includes(sender) &&
        isStopRequest(text, connection.botUserId) &&
        !alreadySeen(eventKey)
      ) {
        const stopSession = channelSessionKey({
          channel: 'slack',
          agentId: connection.config.agentId,
          team,
          conversation: event.channel,
          ...(thread ? { thread } : {}),
        });
        if (stopTurns(connection, stopSession, sender, event.channel, thread)) {
          return undefined;
        }
        log(`slack: ${connection.config.agentId} refused a message from ${sender}: not a listed principal, and admit is "principals"`);
        return undefined;
      }
      const refusal = `slack: ${connection.config.agentId} refused a message from ${sender}: not a listed principal, and admit is "principals"`;
      // Whose message this is, as for an admitted one: the thread's owner's
      // (card 508), or for a stop, whoever was asked last (card 337).
      const refusedStop = (connection.config.approvers ?? []).includes(sender) && isStopRequest(text, connection.botUserId);
      const held = threadKey === undefined
        ? undefined
        : refusedStop ? stopHolderAt(threadKey, event.ts) : replyTargetAt(threadKey, sender, event.ts);
      if (addressed || held === connection.config.agentId) {
        if (!alreadySeen(eventKey)) {
          log(refusal);
        }
      } else if (held === undefined && event.thread_ts !== undefined && !alreadySeen(eventKey)) {
        // Nothing in memory says whose thread this is — after a restart, or
        // once the record was evicted — but the sessions may: the durable
        // half of the question the admitted path asks, and the same
        // verdict. Off the intake chain, because a refused message gets no
        // place in that queue, and the line is an audit, not a turn; `track`
        // holds it so `stop()` drains it like any other background work.
        const thread = event.thread_ts;
        track(followUpWinner({
          team,
          conversation: event.channel,
          thread,
          ...(event.parent_user_id !== undefined ? { parentUser: event.parent_user_id } : {}),
        }, event.ts, refusedStop ? 'stop' : 'reply').then((winner) => {
          if (winner === connection.config.agentId) {
            log(refusal);
          }
        }));
      }
      return undefined;
    }

    if (!addressed) {
      if (event.thread_ts === undefined) {
        // The room is not a conversation: a message that starts a thread,
        // or stands alone, is a follow-up to nothing.
        return undefined;
      }
    }

    // One Slack MESSAGE, not one delivery. An app subscribed to both
    // `app_mention` and `message.channels` is told about a mention twice —
    // two envelopes carrying two event ids — so keying this on the event
    // id would run the turn twice the moment thread follow-through was
    // switched on. `(channel, ts)` names the message itself, and a
    // redelivery (what the event id was here for) repeats both.
    //
    // After the handover record and not before it: a redelivery re-records
    // the same agent, which costs nothing, while deduping first would drop
    // the record whenever the other copy of a doubly-delivered mention is
    // the one a connection sees second. And before every stand-down below,
    // because standing down is no longer nothing: an agent that hears a
    // message it is not answering must hear it once.
    if (alreadySeen(eventKey)) {
      return undefined;
    }

    const admission: Admission = {
      event,
      isDm,
      team,
      eventKey,
      userId: event.user,
      sessionId: channelSessionKey({
        channel: 'slack',
        agentId: connection.config.agentId,
        team,
        conversation: event.channel,
        ...(thread ? { thread } : {}),
      }),
      ...(thread ? { thread } : {}),
      ...(threadKey ? { threadKey } : {}),
      settled: true,
      overhear: false,
      judge: false,
    };

    if (addressed) {
      // A message that named this agent and others is recorded above under
      // whichever of them comes first in connection order — every agent
      // named answers it, and the thread it leaves behind has one holder
      // that all the sockets agree on, which is the only self-consistent
      // reading of a message that asked several.
      return admission;
    }

    if (named) {
      // Somebody else was asked. Tagging an agent hands it the question,
      // and the agent that had it is no longer being asked — two answers
      // to one message is what a thread with a roster in it must never
      // produce. But the agent that had it is still in the room, and a
      // person in that position hears the question asked of their
      // colleague: it goes into this agent's session, unanswered, so the
      // next thing it is asked is asked of someone who followed along.
      return { ...admission, overhear: true };
    }

    // An untagged reply. How this agent listens decides what it is: an
    // agent that answers only mentions hears it and nothing more. One that
    // judges takes a turn nobody asked for on it — one it may stay quiet
    // on — when the reply is its own by the rule every agent shares (card
    // 541): the agent this person last addressed, else the thread's owner.
    // No window: an owner an hour past its last answer still hears an
    // instruction as its own, and exactly one agent takes each reply.
    const listens = listensOf(connection.config.agentId);
    if (listens === 'mentions' || listens === 'judge') {
      // Except a stop (card 337): the holder rule decides whose it is, as
      // for any agent, and it only acts if there is something to stop. A
      // thread the record has forgotten is left to the sessions, as below,
      // so a stop for a turn that outlived its record still reaches it.
      const approverStop = threadKey !== undefined &&
        (connection.config.approvers ?? []).includes(sender) &&
        isStopRequest(text, connection.botUserId);
      const stopHolder = approverStop ? holderAt(threadKey, event.ts) : undefined;
      if (listens === 'judge' && !approverStop && threadKey !== undefined) {
        const target = replyTargetAt(threadKey, sender, event.ts);
        if (target === undefined) {
          // Nothing seen here says whose thread this is: the sessions and
          // the thread read decide, as for any agent.
          return { ...admission, overhear: true, judge: true, settled: false, judgeReason: 'owner, from the thread read' };
        }
        if (target !== connection.config.agentId) {
          return { ...admission, overhear: true, judgeReason: `${target}'s reply` };
        }
        const reason = senderAddresseeAt(threadKey, sender, event.ts) === target ? 'addressed it last' : 'owner';
        return { ...admission, overhear: true, judge: true, judgeReason: reason };
      }
      // An approver's stop is never judged (card 541): it stops the turn of
      // whoever holds the thread, and with nothing to stop it is only heard.
      return {
        ...admission,
        overhear: true,
        ...(stopHolder === connection.config.agentId ? { holderStop: true } : {}),
        ...(approverStop && stopHolder === undefined ? { settled: false } : {}),
      };
    }

    // The record is what this process has actually seen, in the order it
    // saw it — right even inside the window before a handover reaches the
    // store. Whose an untagged reply is, is the thread's owner's (card
    // 508), not the last speaker's — except a stop, which is for whoever
    // was asked last, since that is the turn it means (card 337).
    const stopRequest = threadKey !== undefined &&
      (connection.config.approvers ?? []).includes(sender) &&
      isStopRequest(text, connection.botUserId);
    const holder = threadKey === undefined
      ? undefined
      : stopRequest ? stopHolderAt(threadKey, event.ts) : replyTargetAt(threadKey, sender, event.ts);
    if (holder !== undefined && threadKey !== undefined) {
      if (holder !== connection.config.agentId) {
        // Standing down for the holder, whether or not the holder can still
        // hear it. An app removed from this channel stops receiving the
        // thread, and its untagged replies then reach nobody until somebody
        // names an agent — which is the same answer this adapter gives
        // whenever the agent being addressed cannot answer, and one mention
        // reopens the conversation. Doing better means per-channel
        // membership the adapter does not track, and would have to be
        // tracked in the durable path too, since a removed app is still a
        // live connection with the newest session there.
        //
        // Standing down is not leaving: the reply is the holder's, and this
        // agent hears it.
        return { ...admission, overhear: true };
      }
      rememberAddressee(threadKey, connection.config.agentId, event.ts);
      // Untagged, so it may need nothing back: a thanks, an acknowledgment
      // (card 601). A stop never gets here as a turn to answer.
      return { ...admission, replyOptional: true };
    }
    // Nothing seen for this thread since startup: only the sessions can
    // answer, and that answer has to be awaited.
    return { ...admission, settled: false, replyOptional: true };
  };

  return { stopTurns, teamAgentFor, answersAgentMention, admit };
};

export type Admitter = ReturnType<typeof createAdmitter>;
