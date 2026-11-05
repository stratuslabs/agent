/*
 * Who holds and who owns each thread: the handover record, the read and
 * trim marks, thread origins, the positions a cold thread read rebuilds,
 * and follow-up resolution (which agent an untagged reply is for).
 *
 * Moved out of `createSlackChannelAdapter` in index.ts as is: the
 * statements are unchanged, inside a factory that takes what they closed
 * over there, and the adapter calls it exactly where they were. The edits:
 * `liveFrom` and `gatewayRef` are `let`s, so they are read through
 * `getLiveFrom()` and `getGateway()`, and one `getLiveFrom()` in
 * `unreadBefore` is cast `as string`, since a second call doesn't keep the
 * `!== undefined` narrowing of the first. `teamAgentFor` and
 * `answersAgentMention` are defined after this block, so the adapter passes
 * each as an arrow that calls it. Nothing here is public.
 */

import { admitsSender, channelSessionKey, type GatewayLike, type ListensMode } from '@stratusagent/core';
import { dispatchKeyFor } from './reply.ts';
import type { AgentConnection } from './connection.ts';
import type { Handover } from './handover.ts';
import type { SlackAgentConfig, SlackSocketEventArgs, SlackThreadMessage } from './index.ts';

/**
 * How many claims on one thread it remembers.
 *
 * A message older than all of them asks the sessions instead, which answer
 * for the thread as it stands rather than as it stood — so a reply that old
 * can be resolved to the agent holding the thread now. That is the cost of
 * bounding this, and something has to bound it: the alternative is a list
 * that grows with a conversation for the life of the daemon.
 *
 * A claim is a change of hands or a reply that landed (see
 * `rememberAddressee`), so a busy thread writes one or two per message.
 * Thirty-two sits far past the case the record covers: it only has to
 * span the lag between two sockets, which is messages inside one delivery
 * window, and crossing it needs that many replies in one thread while a
 * socket stays behind for all of them.
 */
const THREAD_HANDOVER_DEPTH = 32;

/**
 * How many cold verdicts are remembered. Far smaller than the addressee
 * map: one is wanted only while the agents sharing a thread resolve the
 * same message, and the addressee record answers for every message after.
 */
const COLD_VERDICT_CAPACITY = 256;

/**
 * The holder-record name for a bot this adapter does not serve: an agent on
 * another gateway, or any other app. The colon keeps it from ever equaling
 * an agent id, so the holder rule reads it as "somebody else's".
 */
const FOREIGN_SPEAKER_PREFIX = 'slack-bot:';

/**
 * A thread read for the cold routing question: where each agent first
 * (`held`) and last (`last`) held the thread, where another app first and
 * last spoke, and each agent's own messages with whether it had been asked.
 */
type ThreadPositions = {
  held: Map<string, number>;
  last: Map<string, number>;
  foreign: number;
  lastForeign: number;
  /** `ts` is the message's own, kept as Slack wrote it for the live record. */
  posts: Array<{ agentId: string; at: number; ts: string; asked: boolean }>;
};

/** What createThreadTracking closes over: values createSlackChannelAdapter owns. */
export interface ThreadTrackingDeps {
  warn: (line: string) => void;
  connections: AgentConnection[];
  configuredAgents: Set<string>;
  threadAddressee: Map<string, Handover[]>;
  threadTrimmedUntil: Map<string, string>;
  threadReadUntil: Map<string, string>;
  getLiveFrom: () => string | undefined;
  threadOrigins: Map<string, string | true>;
  coldVerdicts: Map<string, { verdict: Promise<string | undefined>; settled: boolean }>;
  botIdentities: Map<string, { botUserId: string; teamId: string }>;
  getGateway: () => GatewayLike | undefined;
  agentConfigFor: (agentId: string) => SlackAgentConfig | undefined;
  homeOwners: Map<string, string>;
  listensOf: (agentId: string) => ListensMode;
  teamAgentFor: (config: SlackAgentConfig, agentTeam: string | undefined, team: string, botUser: string) => string | undefined;
  answersAgentMention: (agentId: string, team: string, botUser: string) => boolean;
  THREAD_ADDRESSEE_CAPACITY: number;
  compareSlackTs: (left: string, right: string) => number;
  HUMAN_MESSAGE_SUBTYPES: Set<string>;
  mentions: (text: string, botUserId: string) => boolean;
  EARLIER_THREAD_PAGES: number;
}

export const createThreadTracking = ({
  warn,
  connections,
  configuredAgents,
  threadAddressee,
  threadTrimmedUntil,
  threadReadUntil,
  getLiveFrom,
  threadOrigins,
  coldVerdicts,
  botIdentities,
  getGateway,
  agentConfigFor,
  homeOwners,
  listensOf,
  teamAgentFor,
  answersAgentMention,
  THREAD_ADDRESSEE_CAPACITY,
  compareSlackTs,
  HUMAN_MESSAGE_SUBTYPES,
  mentions,
  EARLIER_THREAD_PAGES,
}: ThreadTrackingDeps) => {
  /** One thread, whichever agent is talking in it. */
  const threadKeyFor = (parts: { team: string; conversation: string; thread: string }): string =>
    `${parts.team}:${parts.conversation}:${parts.thread}`;

  /**
   * A thread's claims cut to `THREAD_HANDOVER_DEPTH`, oldest first out, but
   * never the two `ownerAt` reads past the rest, so at most one over: the
   * first claim, which is who the thread belongs to, and the latest claim
   * that took the thread.
   * Dropping that one would hand the thread back to its owner after enough
   * mentions of a third agent, while the judge that took it still answers.
   */
  const trimHandovers = (key: string, handovers: Handover[]): Handover[] => {
    if (handovers.length <= THREAD_HANDOVER_DEPTH) {
      return handovers;
    }
    const first = handovers[0] as Handover;
    let latestTake = -1;
    for (let index = handovers.length - 1; index > 0; index -= 1) {
      if (handovers[index]?.takes === true) {
        latestTake = index;
        break;
      }
    }
    const tailFrom = handovers.length - (THREAD_HANDOVER_DEPTH - 1);
    // The kept take sits on top of the full recent tail, one past the depth,
    // so `holderAt` still sees every recent claim it saw before.
    const tail = handovers.slice(tailFrom);
    // The cut only ever moves later: a claim inserted into the gap since
    // is dropped again, and the gap it fell in stays unknown.
    const until = (tail[0] as Handover).ts;
    const before = threadTrimmedUntil.get(key);
    if (before === undefined || before < until) {
      threadTrimmedUntil.set(key, until);
    }
    return latestTake > 0 && latestTake < tailFrom
      ? [first, handovers[latestTake] as Handover, ...tail]
      : [first, ...tail];
  };

  /**
   * Records that `agentId` holds the thread from the message at `ts`
   * onwards, wherever in the thread's history that message falls.
   *
   * Every claim is kept, not only changes of hands. A claim by the agent
   * already holding the thread looks redundant until another agent's reply
   * is placed between it and the one before — a judge's reply posted below
   * the holder's older message and above its newer one — at which point it
   * is what keeps the newer message the holder's; dropped, the judge's
   * later insertion would take the thread from a reply that sits below it.
   * Only the same claim twice — the same message reaching a second
   * connection — is dropped.
   * The oldest claims are dropped past `THREAD_HANDOVER_DEPTH` (but not
   * the first or the latest that took the thread: `trimHandovers`), and the
   * least recently written thread past `THREAD_ADDRESSEE_CAPACITY`; both
   * losses cost a lookup, never an answer, since the sessions still hold
   * the durable version.
   *
   * `ts` is a message's place in the thread: the message that handed the
   * thread over at intake, or — once a reply has landed — the reply's own
   * (`ReplyOutcome.spokeAt`), which is what puts a judge's reply posted
   * below a colleague's placeholder after it, and one streamed above it
   * before, whichever turn finished first.
   *
   * Slack timestamps compare as strings: `seconds.microseconds`, both
   * parts fixed width, so lexicographic order is chronological order.
   */
  const rememberAddressee = (key: string, agentId: string, ts: string, takes = false, cold = false): void => {
    const handovers = threadAddressee.get(key) ?? [];
    let at = handovers.length;
    while (at > 0 && (handovers[at - 1] as { ts: string }).ts > ts) {
      at -= 1;
    }
    const before = handovers[at - 1];
    if (before && before.agentId === agentId && before.ts === ts) {
      if (takes) {
        before.takes = true;
      }
      // Seen live as well: no longer only a reconstruction.
      if (!cold) {
        delete before.cold;
      }
      return;
    }
    handovers.splice(at, 0, { agentId, ts, ...(takes ? { takes } : {}), ...(cold ? { cold } : {}) });
    // Re-inserted rather than mutated in place: a Map iterates in insertion
    // order, which is what makes the first key the one to evict.
    threadAddressee.delete(key);
    threadAddressee.set(key, trimHandovers(key, handovers));
    if (threadAddressee.size > THREAD_ADDRESSEE_CAPACITY) {
      const oldest = threadAddressee.keys().next();
      if (!oldest.done) {
        threadAddressee.delete(oldest.value);
        threadTrimmedUntil.delete(oldest.value);
        threadReadUntil.delete(oldest.value);
        // The owner goes with the record of who took the thread since: an
        // owner kept alone would stand in for a judge's takeover it no
        // longer knows of, where the thread read would see it.
        threadOrigins.delete(oldest.value);
      }
    }
  };

  /**
   * Who held the thread when the message at `ts` was sent — the last
   * handover at or before it. Undefined when this process has no handover
   * that old, which sends the question to the sessions.
   */
  /**
   * Whose a stop at `ts` is, from the live record: who was asked last as
   * of `ts` (`holderAt`). Undefined when the record cannot say, either
   * because this process has seen nobody asked here by `ts`, or because the
   * newest entry by then was rebuilt from a thread read (card 508): a
   * mention since would not be among them. The stop is then left to a
   * fresh read of the thread, never sent to the owner on a guess.
   */
  const stopHolderAt = (key: string, ts: string): string | undefined => holderAt(key, ts);

  /** Whether the record of thread `key` lost who held it at `ts` to a cut. */
  const inTrimmedGap = (key: string, handovers: Handover[], ts: string): boolean => {
    const until = threadTrimmedUntil.get(key);
    const first = handovers[0];
    return until !== undefined && first !== undefined && first.ts < ts && ts < until;
  };

  /**
   * Records that a thread read of `key` covered every message before `ts`.
   * Bounded on its own, since a read that found nobody's post leaves an
   * owner and no record (Codex 4321103567). A thread whose mark is evicted
   * loses its record and owner with it, so it is read afresh instead of
   * placed from claims the read may have stopped short of.
   */
  const noteReadUntil = (key: string, ts: string): void => {
    const until = threadReadUntil.get(key);
    threadReadUntil.delete(key);
    threadReadUntil.set(key, until !== undefined && compareSlackTs(ts, until) < 0 ? until : ts);
    if (threadReadUntil.size > THREAD_ADDRESSEE_CAPACITY) {
      const oldest = threadReadUntil.keys().next();
      if (!oldest.done) {
        threadReadUntil.delete(oldest.value);
        threadAddressee.delete(oldest.value);
        threadTrimmedUntil.delete(oldest.value);
        threadOrigins.delete(oldest.value);
      }
    }
  };

  /**
   * Where the record of thread `key` stops knowing every take, for a
   * message at `ts` after what a thread read covered (card 562): a claim
   * older than the returned point may have been taken from since, unseen.
   * Undefined when the record is complete as far as `ts`.
   */
  const unreadBefore = (key: string, ts: string): string | undefined => {
    const until = threadReadUntil.get(key);
    return until !== undefined && getLiveFrom() !== undefined && compareSlackTs(until, getLiveFrom() as string) < 0 && compareSlackTs(ts, until) > 0
      ? getLiveFrom()
      : undefined;
  };

  const holderAt = (key: string, ts: string): string | undefined => {
    const handovers = threadAddressee.get(key);
    if (!handovers || inTrimmedGap(key, handovers, ts)) {
      return undefined;
    }
    // The newest entry at or before `ts` answers, and only if this process
    // saw it live. A claim rebuilt from a thread read is a post; who was
    // asked since may be a mention it cannot see, so it leaves the question
    // to a fresh read. And it is newer than every live entry before it, so
    // skipping it for one of those would answer with a claim it superseded.
    const unread = unreadBefore(key, ts);
    for (let index = handovers.length - 1; index >= 0; index -= 1) {
      const handover = handovers[index];
      if (handover && handover.ts <= ts) {
        return handover.cold === true || (unread !== undefined && compareSlackTs(handover.ts, unread) < 0) ? undefined : handover.agentId;
      }
    }
    return undefined;
  };

  /**
   * Who an untagged reply at `ts` belongs to (card 508): the agent the
   * thread belongs to, not whoever spoke last. That is the first to hold
   * it — the agent its first message named, a home channel's owner, or the
   * bot (this daemon's or another's) that posted it — unless a judging
   * agent has since chosen to speak, which takes it (`takes`). A mention
   * of another agent gets that agent's answer to that message and nothing
   * more: the thread stays where it was, and so does every reply after.
   * In a thread that began before this process did, and that the thread
   * read has not placed yet, the first claim this process SAW stands in
   * for the owner: the best it has, and no worse than the last-speaker
   * rule it replaces. Undefined when this process has seen no claim at
   * all, which sends the question to the sessions and the thread.
   */
  const ownerAt = (key: string, ts: string): string | undefined => {
    const origin = threadOrigins.get(key);
    const handovers = threadAddressee.get(key) ?? [];
    if (inTrimmedGap(key, handovers, ts)) {
      return undefined;
    }
    // A take from before the stretch the read left out may have been
    // superseded there: the question goes to a fresh read (card 562).
    const unread = unreadBefore(key, ts);
    for (let index = handovers.length - 1; index >= 0; index -= 1) {
      const handover = handovers[index];
      if (handover && handover.ts <= ts && (handover.takes === true || (index === 0 && typeof origin !== 'string'))) {
        return unread !== undefined && compareSlackTs(handover.ts, unread) < 0 ? undefined : handover.agentId;
      }
    }
    return typeof origin === 'string' && unread === undefined ? origin : undefined;
  };

  /**
   * The agent the thread `key` belongs to, whoever holds it now: the owner
   * the thread read settled, or else the first claim this process saw.
   * Answering in its own thread takes the thread back from a judge that
   * spoke since (card 508), so the owner is asked for here, not the holder.
   */
  const threadOwner = (key: string): string | undefined => {
    const origin = threadOrigins.get(key);
    return typeof origin === 'string' ? origin : threadAddressee.get(key)?.[0]?.agentId;
  };

  /** Records that this process saw the thread `key` begin, or who owns it. */
  const noteOrigin = (key: string, owner: true | string = true): void => {
    if (owner === true && threadOrigins.has(key)) {
      return;
    }
    threadOrigins.delete(key);
    threadOrigins.set(key, owner);
    if (threadOrigins.size > THREAD_ADDRESSEE_CAPACITY) {
      const oldest = threadOrigins.keys().next();
      if (!oldest.done) {
        threadOrigins.delete(oldest.value);
      }
    }
  };

  /**
   * A message that starts a thread, seen by any connection: from here on
   * this process sees the thread's first claim, so it knows the owner. One
   * this daemon's own agent posted (a schedule's delivery, a message.send)
   * is that agent's thread.
   */
  const noteThreadStart = (connection: AgentConnection, args: SlackSocketEventArgs): void => {
    const event = args.event;
    if (!event || (event.type !== 'message' && event.type !== 'app_mention') || event.channel_type === 'im') {
      return;
    }
    if (event.thread_ts !== undefined && event.thread_ts !== event.ts) {
      return;
    }
    if (event.subtype !== undefined && event.subtype !== 'bot_message' && !HUMAN_MESSAGE_SUBTYPES.has(event.subtype)) {
      return;
    }
    const team = args.body?.team_id ?? connection.teamId;
    const key = threadKeyFor({ team, conversation: event.channel, thread: event.ts });
    if (threadOrigins.has(key)) {
      return;
    }
    noteOrigin(key);
    if (event.user !== undefined) {
      for (const [agentId, identity] of botIdentities) {
        if (identity.teamId === team && identity.botUserId === event.user) {
          rememberAddressee(key, agentId, event.ts);
        }
      }
    }
    // A team agent on another gateway that starts a thread owns it, even
    // when its first message asks an agent here something: that agent
    // answers the question, and the thread stays the asker's. Recorded
    // here, ahead of the answer, since `noteForeignSpeaker` leaves out a
    // bot's question to an agent here.
    const bot = event.bot_id !== undefined || event.subtype === 'bot_message';
    if (bot && event.user !== undefined && !isFleetBot(team, event.user) && !startsThreadAsIntegration(team, event.user, event.thread_ts, event.ts)) {
      rememberAddressee(key, `${FOREIGN_SPEAKER_PREFIX}${event.user}`, event.ts);
    }
  };

  /**
   * Whether `user` is one of this adapter's own agents in `team`. Their
   * replies reach the holder record through `ReplyOutcome.spokeAt`, and
   * their sessions answer for them after a restart.
   */
  const isFleetBot = (team: string, user: string | undefined): boolean =>
    user !== undefined && [...botIdentities.values()].some(
      (identity) => identity.teamId === team && identity.botUserId === user,
    );

  /**
   * Whether a bot message is a team agent asking one of this daemon's
   * agents something (card 513): a question, not another voice taking the
   * thread. The agent asked answers it, and the thread stays with whoever
   * held it. Used live and when a thread is read back after a restart.
   */
  const asksAgentHere = (team: string, asker: string | undefined, text: string | undefined): boolean =>
    asker !== undefined && [...botIdentities].some(([agentId, identity]) =>
      identity.teamId === team && mentions(text ?? '', identity.botUserId) && answersAgentMention(agentId, team, asker));

  /**
   * Whether a bot message is another app starting a thread — an alert, a
   * deploy note — rather than an agent (card 508). That starts the thread
   * without owning it, so an agent named under it keeps the conversation it
   * was given. A team agent (`agentMentions.team`) starting one owns it the
   * way an agent here does, and any app replying inside a thread counts as
   * a speaker there, since an agent on a gateway nobody listed looks like
   * any other app.
   */
  const startsThreadAsIntegration = (team: string, user: string | undefined, threadTs: string | undefined, ts: string): boolean => {
    if (threadTs !== undefined && threadTs !== ts) {
      return false;
    }
    return user === undefined || ![...botIdentities].some(([agentId, identity]) => {
      const config = agentConfigFor(agentId);
      return config !== undefined && teamAgentFor(config, identity.teamId, team, user) !== undefined;
    });
  };

  /**
   * Records a bot this adapter does not serve as the thread's holder from
   * the message it posted. An agent on another gateway answers in the same
   * threads, and nothing in this process's sessions knows it spoke: without
   * this, an agent here that spoke earlier keeps taking every untagged reply,
   * and the reply meant for the other agent is answered twice. Only who
   * spoke and when is kept, never what was said; the bot's message itself is
   * still dropped by `admit`. Any app counts, an integration included: an
   * untagged reply right after another app posted is not plainly this
   * agent's, and naming the agent hands the thread back.
   */
  const noteForeignSpeaker = (connection: AgentConnection, args: SlackSocketEventArgs): void => {
    const event = args.event;
    if (!event || event.type !== 'message' || event.channel_type === 'im') {
      return;
    }
    if (event.bot_id === undefined && event.subtype !== 'bot_message') {
      return;
    }
    if (event.subtype !== undefined && event.subtype !== 'bot_message' && !HUMAN_MESSAGE_SUBTYPES.has(event.subtype)) {
      // An edit, a deletion, a join: not somebody speaking.
      return;
    }
    const team = args.body?.team_id ?? connection.teamId;
    const speaker = event.user ?? event.bot_id;
    if (speaker === undefined || isFleetBot(team, event.user)) {
      return;
    }
    if (asksAgentHere(team, event.user, event.text)) {
      return;
    }
    if (startsThreadAsIntegration(team, event.user, event.thread_ts, event.ts)) {
      return;
    }
    const thread = event.thread_ts ?? event.ts;
    rememberAddressee(threadKeyFor({ team, conversation: event.channel, thread }), `${FOREIGN_SPEAKER_PREFIX}${speaker}`, event.ts);
  };

  /**
   * The durable half of `noteForeignSpeaker`, for a thread this process has
   * no record of: where each of `candidates` last held the thread, and where
   * a bot this adapter does not serve last spoke, read from the thread
   * itself. Held means an agent's own message there or a person's message
   * naming it that it would admit, by position in the thread (its session's
   * `lastSpokeAt` only when its bot user id is unknown). Undefined whenever
   * it cannot tell: no thread read, a failed read, or a thread too long to
   * reach its newest replies. Then the reply is routed as it was before
   * this check.
   */
  const threadPositions = async (
    candidates: Array<{ agentId: string; lastSpokeAt?: string }>,
    parts: { team: string; conversation: string; thread: string },
    ts: string,
  ): Promise<ThreadPositions | undefined> => {
    const connection = connections.find((candidate) => candidate.config.agentId === candidates[0]?.agentId)
      ?? connections.find((candidate) => candidate.teamId === parts.team);
    const replies = connection?.web.conversations.replies;
    if (!connection || !replies) {
      return undefined;
    }
    // Positions in the thread, as the live record keeps them: a reply that
    // filled a placeholder sits where the placeholder was posted, above
    // anything posted while it was being written, though the transcript
    // dates it later. `lastSpokeAt` stands in only when an agent's own
    // messages can't be told apart in the read.
    const held = new Map<string, number>();
    const byBotUser = new Map<string, string>();
    for (const candidate of candidates) {
      const botUserId = botIdentities.get(candidate.agentId)?.botUserId;
      if (botUserId !== undefined) {
        byBotUser.set(botUserId, candidate.agentId);
        held.set(candidate.agentId, Number.POSITIVE_INFINITY);
        continue;
      }
      const spoke = candidate.lastSpokeAt === undefined ? Number.NaN : Date.parse(candidate.lastSpokeAt) / 1000;
      held.set(candidate.agentId, Number.isFinite(spoke) ? spoke : Number.POSITIVE_INFINITY);
    }
    // Where each last held it, for a stop, which is for whoever was asked
    // last (card 337), not for the thread's owner.
    const last = new Map<string, number>();
    for (const [agentId, at] of held) {
      last.set(agentId, Number.isFinite(at) ? at : 0);
    }
    const place = (agentId: string, at: number): void => {
      held.set(agentId, Math.min(held.get(agentId) ?? Number.POSITIVE_INFINITY, at));
      last.set(agentId, Math.max(last.get(agentId) ?? 0, at));
    };
    let foreign = Number.POSITIVE_INFINITY;
    let lastForeign = 0;
    // Each of these agents' own messages, and whether the message before it
    // had asked it anything: one nobody asked for is a judge taking the
    // thread, or its owner answering in it (card 508).
    const posts: Array<{ agentId: string; at: number; ts: string; asked: boolean }> = [];
    let asked = new Set<string>();
    const askedIn = (text: string | undefined): Set<string> => new Set(
      [...byBotUser].filter(([botUserId]) => mentions(text ?? '', botUserId)).map(([, agentId]) => agentId),
    );
    try {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page: { messages?: SlackThreadMessage[]; response_metadata?: { next_cursor?: string } } = await replies.call(connection.web.conversations, {
          channel: parts.conversation,
          ts: parts.thread,
          latest: ts,
          inclusive: false,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        pages += 1;
        for (const message of page.messages ?? []) {
          const at = Number(message.ts);
          if (!Number.isFinite(at) || !(at < Number(ts))) {
            continue;
          }
          const own = message.user === undefined ? undefined : byBotUser.get(message.user);
          if (own !== undefined) {
            place(own, at);
            posts.push({ agentId: own, at, ts: message.ts as string, asked: asked.has(own) });
            // An agent here naming a colleague that answers its mentions
            // asks it, as `admitAgentMention` has it live, so the answer is
            // not a judge speaking unasked.
            const sender = message.user;
            const named = sender === undefined
              ? []
              : [...askedIn(message.text)].filter((agentId) => agentId !== own && answersAgentMention(agentId, parts.team, sender));
            if (named.length > 0) {
              asked = new Set(named);
            }
            continue;
          }
          const bot = message.bot_id !== undefined || message.subtype === 'bot_message';
          if (bot) {
            // A bot's mention hands nothing over live (admit ignores bots),
            // so here it is only another app speaking, or a peer's words.
            // A team agent's question to an agent here is not it taking the
            // thread, unless it started the thread with it: then the thread
            // is its own, as it is live.
            const asks = asksAgentHere(parts.team, message.user, message.text);
            if (asks) {
              asked = askedIn(message.text);
            }
            if (
              !isFleetBot(parts.team, message.user) &&
              (!asks || message.ts === parts.thread) &&
              !startsThreadAsIntegration(parts.team, message.user, parts.thread, message.ts ?? '')
            ) {
              foreign = Math.min(foreign, at);
              lastForeign = Math.max(lastForeign, at);
            }
            continue;
          }
          // A person naming an agent takes the thread for it only if that
          // agent would admit them, as the live handover does.
          const sender = message.user;
          if (sender === undefined) {
            continue;
          }
          asked = askedIn(message.text);
          const named = agentNamedIn(message.text ?? '', parts.team, (agentId) => admitsSender(agentConfigFor(agentId), sender));
          if (named !== undefined && held.has(named) && botIdentities.get(named)?.botUserId !== undefined) {
            place(named, at);
          }
          // A root that names nobody in a home channel is its owner's, as
          // the live home-channel rule has it.
          const home = message.ts === parts.thread && named === undefined
            ? homeOwners.get(`${parts.team}:${parts.conversation}`)
            : undefined;
          if (home !== undefined && held.has(home) && admitsSender(agentConfigFor(home), sender)) {
            place(home, at);
          }
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor && pages < EARLIER_THREAD_PAGES);
      if (cursor) {
        return undefined;
      }
    } catch (error) {
      warn(`slack: could not read thread ${parts.thread} in ${parts.conversation} to see who spoke last, so it is routed as before: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    return { held, last, foreign, lastForeign, posts };
  };

  /**
   * Which of this process's agents a message names, or undefined if it
   * names none of them.
   *
   * When it names several, the first that is actually serving — and any
   * of them otherwise. That determinism is the point: every connection sees every message and runs
   * this over the same text and the same array, so all of them agree on who
   * a message handed the thread to — including the connections that will go
   * on to ignore it. Which is what makes the handover record converge
   * without the sockets having to agree on anything, since each agent is
   * its own Socket Mode connection and one can run minutes behind another.
   *
   * Scoped to the message's own workspace, because a bot user id is only
   * unique within one — the same reason the display-name cache is keyed by
   * team. Two agents in two workspaces can hold the same id, and resolving
   * a mention to the wrong one would hand the thread to an agent that
   * cannot see it, leaving the agent that was actually named refusing every
   * reply after.
   *
   * Only agents this adapter has authenticated can be recognized at all.
   * One served by another daemon is invisible here, and both would answer;
   * so is one whose `auth.test` itself failed, since its bot id was never
   * learned.
   */
  const agentNamedIn = (
    text: string,
    team: string,
    /**
     * Whether a named agent would take this message at all. A message
     * naming two agents hands the thread to one that admits the sender,
     * not to the first one named: the agent that refuses will not answer,
     * and a handover to it is a thread nobody holds.
     */
    admits: (agentId: string) => boolean = () => true,
  ): string | undefined => {
    let offline: string | undefined;
    for (const [agentId, identity] of botIdentities) {
      if (identity.teamId !== team || !mentions(text, identity.botUserId) || !admits(agentId)) {
        continue;
      }
      if (connections.some((live) => live.config.agentId === agentId)) {
        return agentId;
      }
      // Named, recognized, and not serving. Remembered only as the answer
      // of last resort: a message that names an agent whose app is down and
      // nobody else still gets silence, which is the deliberate behavior —
      // but a message that also names one that IS serving must leave the
      // thread with the agent that can actually answer it, or the reply it
      // just posted would be the last anyone gets.
      offline ??= agentId;
    }
    return offline;
  };

  /**
   * Who an untagged reply belongs to, asked of the SESSIONS — the durable
   * answer, for a thread this process has no record of: one it has not seen
   * a message in since it started, or one evicted from `threadAddressee`.
   * Everything else is settled synchronously in `admit`, before this is
   * ever reached.
   *
   * Being in the thread is the first half: a session under a thread's key
   * exists only because someone mentioned that agent here, so an agent
   * follows up only in conversations it was invited into, and stops when
   * the thread is gone. `sessionRouting` is the durable record of that — a
   * restart forgets nothing.
   *
   * Whose turn it is, is the second. In a thread with several agents an
   * unaddressed reply belongs to the agent the thread belongs to (card
   * 508): the first to hold it, read off the thread itself. Only when the
   * thread can't be read do the sessions decide, and then by `lastSpokeAt`
   * — when each agent last *replied*, not when its session last changed,
   * because a turn saves on tool results and approval checkpoints without
   * having said anything — since that is the only order they keep.
   *
   * Nobody is the answer only when the agents cannot be *ordered* — nothing
   * in the thread has spoken, or two tie — because guessing there would put
   * two answers under one message. The agent alone in its thread, which is
   * nearly every thread, is answered without the question arising.
   */
  const resolveFollowUpWinner = async (
    parts: { team: string; conversation: string; thread: string; parentUser?: string },
    ts: string,
    mode: 'reply' | 'stop' = 'reply',
  ): Promise<string | undefined> => {
    const gateway = getGateway();
    if (!gateway?.sessionRouting || !parts.thread) {
      return undefined;
    }
    // A message an agent already accepted is that agent's, whoever has spoken
    // since. Nothing in memory says so after a restart, and the order below
    // would hand a redelivery to the newer speaker — whose session holds no
    // key for it, so it would run the message as new. Asked of every
    // configured agent, whatever it listens to now and whether or not it is
    // connected, unlike the order below: what counts is that it took the
    // message as addressed to it (a judging agent's turn nobody asked for
    // does not), an operator may have changed how it listens since, and an
    // owner whose app failed to come back after the restart still started
    // that turn — the live agents stand down for it rather than run it again.
    // Its workspace is the one it last authenticated in, when known.
    if (gateway.holdsMessage) {
      for (const agentId of configuredAgents) {
        const teamId = botIdentities.get(agentId)?.teamId;
        if (teamId !== undefined && teamId !== parts.team) {
          continue;
        }
        const sessionId = channelSessionKey({
          channel: 'slack',
          agentId,
          team: parts.team,
          conversation: parts.conversation,
          thread: parts.thread,
        });
        if (await gateway.holdsMessage(sessionId, dispatchKeyFor(`${agentId}:${parts.conversation}:${ts}`))) {
          return agentId;
        }
      }
    }
    const engaged: Array<{ agentId: string; lastSpokeAt?: string }> = [];
    // Live connections in this message's OWN workspace. Live, because an
    // agent whose app failed to connect cannot answer anything, and leaving
    // a thread silent because its last speaker is offline is the bug this
    // whole change exists to remove. In-workspace, because a session key
    // carries a team: an agent whose app has moved workspaces still has its
    // old sessions there, and letting those contend for a thread it can no
    // longer receive a message in would leave nobody to answer.
    for (const candidate of connections) {
      if (candidate.teamId !== parts.team) {
        continue;
      }
      const routing = await gateway.sessionRouting(channelSessionKey({
        channel: 'slack',
        agentId: candidate.config.agentId,
        team: parts.team,
        conversation: parts.conversation,
        thread: parts.thread,
      }));
      if (!routing) {
        continue;
      }
      engaged.push({
        agentId: candidate.config.agentId,
        ...(routing.lastSpokeAt !== undefined ? { lastSpokeAt: routing.lastSpokeAt } : {}),
      });
    }
    const first = engaged[0];
    if (!first) {
      // No agent has a session in this thread, but one may have STARTED
      // it: a post made through message.send or a schedule's delivery
      // lands at the top level from some other session, so nothing ties
      // the thread under it to the agent that wrote it. A reply there is
      // a reply to that agent. Read off the event, so every connection
      // reaches the same answer, and after a restart too. Looked up among
      // authenticated identities, not live sockets: they are all learned
      // before any socket starts, so an agent whose socket is still coming
      // up is not judged absent and the memoized verdict cannot drop the
      // reply when its own socket delivers it.
      if (parts.parentUser === undefined) {
        return undefined;
      }
      for (const [agentId, identity] of botIdentities) {
        if (identity.teamId === parts.team && identity.botUserId === parts.parentUser) {
          noteOrigin(threadKeyFor(parts), agentId);
          return agentId;
        }
      }
      return undefined;
    }
    // The thread says who it belongs to: whichever of these agents held it
    // first — its first message named it, or it posted there first — or
    // another app that spoke before any of them did (card 508). When it
    // can't be read, the sessions decide: the only agent in it, or, as a
    // last resort, the one that spoke last, which is all they record.
    // The agent that posted the root takes part even with no session here:
    // a post made through message.send or a schedule leaves none, and a
    // colleague named under it since must not look like the owner.
    const candidates = [...engaged];
    if (parts.parentUser !== undefined) {
      for (const [agentId, identity] of botIdentities) {
        if (identity.teamId === parts.team && identity.botUserId === parts.parentUser && !candidates.some((entry) => entry.agentId === agentId)) {
          candidates.push({ agentId });
        }
      }
    }
    const read = await threadPositions(candidates, parts, ts);
    if (!read) {
      return engaged.length === 1 ? first.agentId : lastSpeaker(engaged);
    }
    if (mode === 'stop') {
      // A stop is for whoever was asked last (card 337), as `holderAt` has
      // it live: the turn it means is that agent's, not the owner's.
      let holder: { agentId: string; at: number } | undefined;
      let tiedLast = false;
      for (const entry of candidates) {
        const at = read.last.get(entry.agentId) ?? 0;
        if (at <= 0) {
          continue;
        }
        if (!holder || at > holder.at) {
          holder = { agentId: entry.agentId, at };
          tiedLast = false;
        } else if (at === holder.at) {
          tiedLast = true;
        }
      }
      if (!holder) {
        return read.lastForeign > 0 ? undefined : (engaged.length === 1 ? first.agentId : lastSpeaker(engaged));
      }
      return tiedLast || read.lastForeign > holder.at ? undefined : holder.agentId;
    }
    let owner: { agentId: string; at: number } | undefined;
    let tiedAt = false;
    for (const entry of candidates) {
      const at = read.held.get(entry.agentId) ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(at) || at <= 0) {
        continue;
      }
      if (!owner || at < owner.at) {
        owner = { agentId: entry.agentId, at };
        tiedAt = false;
      } else if (at === owner.at) {
        tiedAt = true;
      }
    }
    // A judging agent that spoke unasked took the thread, and the owner
    // answering in it took it back, as live (card 508): the latest of those
    // holds it. The live record of who took it is lost on a restart; the
    // thread keeps it. Only a judge takes by speaking unasked, as only its
    // turns are judged live; another agent's post there (a message.send)
    // takes nothing.
    const ownerId = owner && !tiedAt && !(read.foreign < owner.at) ? owner.agentId : undefined;
    let taken: { agentId: string; at: number; ts: string } | undefined;
    const takeovers: Array<{ agentId: string; at: number; ts: string }> = [];
    for (const post of read.posts) {
      const takes = post.agentId === ownerId || (!post.asked && listensOf(post.agentId) === 'judge');
      if (takes) {
        takeovers.push(post);
        if (!taken || post.at > taken.at) {
          taken = post;
        }
      }
    }
    // Once the owner is known, the live record learns what the thread read
    // found, as it would have live: who owns the thread, and every post
    // that moved it, where it sits. With only the verdict, a judge's reply
    // to this message became the first claim this process saw and read as
    // the owner, so the real owner answering a mention could not take the
    // thread back (Codex 4290051968). Every take rather than the latest, so
    // a message delivered late is placed where it was typed, and the judge's
    // take at its own post, so a reply typed before its answer lands still
    // goes to the judge, as this verdict says.
    const warm = (): void => {
      if (ownerId === undefined) {
        return;
      }
      const key = threadKeyFor(parts);
      noteOrigin(key, ownerId);
      for (const post of takeovers) {
        rememberAddressee(key, post.agentId, post.ts, true, true);
      }
      noteReadUntil(key, ts);
    };
    if (taken && taken.agentId !== ownerId && (ownerId !== undefined || taken.at > read.foreign)) {
      warm();
      return taken.agentId;
    }
    if (!owner) {
      return Number.isFinite(read.foreign) ? undefined : (engaged.length === 1 ? first.agentId : lastSpeaker(engaged));
    }
    if (ownerId === undefined) {
      return undefined;
    }
    warm();
    return ownerId;
  };

  /**
   * Of several agents in a thread, the one whose session says it spoke
   * last — the sessions' only ordering, used when the thread itself can't
   * be read. Undefined when nobody has spoken or the newest two tie, since
   * guessing there would put two answers under one message.
   */
  const lastSpeaker = (engaged: Array<{ agentId: string; lastSpokeAt?: string }>): string | undefined => {
    let latest: { agentId: string; lastSpokeAt: string } | undefined;
    let tied = false;
    for (const entry of engaged) {
      if (entry.lastSpokeAt === undefined) {
        continue;
      }
      if (!latest || entry.lastSpokeAt > latest.lastSpokeAt) {
        latest = { agentId: entry.agentId, lastSpokeAt: entry.lastSpokeAt };
        tied = false;
      } else if (entry.lastSpokeAt === latest.lastSpokeAt) {
        tied = true;
      }
    }
    return tied ? undefined : latest?.agentId;
  };

  /**
   * `resolveFollowUpWinner`, resolved ONCE PER MESSAGE and shared by every
   * agent asking about that message.
   *
   * The sharing is the point. Each agent's own copy of the question is
   * several independent session reads, and turns finishing in between can
   * make two agents' reads disagree: both concluding they are the most
   * recent speaker, so one message is answered twice, or both concluding
   * they are not, so it is answered by nobody. One resolution cannot
   * disagree with itself, which is a stronger guarantee than arbitrating
   * between two that already have.
   *
   * Keyed on the message, so a later reply in the same thread asks again.
   * Bounded, and deliberately not deleted when it settles: an entry has to
   * outlive its own resolution, because an agent it beats may only reach
   * this after the winner has finished, and recomputing for that agent is
   * precisely the disagreement the memo exists to prevent.
   */
  const followUpWinner = (
    parts: { team: string; conversation: string; thread: string },
    ts: string,
    mode: 'reply' | 'stop' = 'reply',
  ): Promise<string | undefined> => {
    // A stop asks a different question (whoever was asked last), so it
    // gets its own verdict, the same for every agent that asks it.
    const key = `${threadKeyFor(parts)}:${ts}${mode === 'stop' ? ':stop' : ''}`;
    const existing = coldVerdicts.get(key);
    if (existing) {
      return existing.verdict;
    }
    const entry = { verdict: resolveFollowUpWinner(parts, ts, mode), settled: false };
    coldVerdicts.set(key, entry);
    void entry.verdict.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
    if (coldVerdicts.size > COLD_VERDICT_CAPACITY) {
      // The oldest SETTLED entry, never simply the oldest. Evicting one
      // still resolving is the one eviction that costs an answer rather
      // than a lookup: the agent it has not reached yet would start its own
      // resolution, which is the disagreement this memo exists to prevent.
      // With none settled there is nothing safe to drop, and the map runs
      // over its cap by however many resolutions are genuinely in flight.
      for (const [candidate, held] of coldVerdicts) {
        if (held.settled) {
          coldVerdicts.delete(candidate);
          break;
        }
      }
    }
    return entry.verdict;
  };

  return {
    threadKeyFor,
    rememberAddressee,
    stopHolderAt,
    holderAt,
    ownerAt,
    threadOwner,
    noteThreadStart,
    isFleetBot,
    noteForeignSpeaker,
    agentNamedIn,
    followUpWinner,
  };
};

export type ThreadTracking = ReturnType<typeof createThreadTracking>;
