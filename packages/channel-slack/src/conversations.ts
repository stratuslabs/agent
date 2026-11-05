/*
 * The room tools the channel contract gives an agent: whether a
 * conversation is a channel or a DM, its bookmarks, reading it, and
 * creating, joining, inviting to and archiving one. Moved out of
 * `createSlackChannelAdapter` in index.ts as is: the statements are
 * unchanged, inside a factory that takes what they closed over there, and
 * the adapter calls it exactly where they were. The one edit:
 * `carried` is a `let` a reload replaces, so it is read through
 * `getCarried()`. Nothing here is public.
 */

import {
  channelSessionKey,
  type ConversationArchiveRequest,
  type ConversationArchiveResult,
  type ConversationBookmark,
  type ConversationCreateRequest,
  type ConversationCreateResult,
  type ConversationInviteRequest,
  type ConversationInviteResult,
  type ConversationJoinRequest,
  type ConversationJoinResult,
  type ConversationMessage,
  type ConversationReadRequest,
  type ConversationReadResult,
} from '@stratusagent/core';
import { historyImageCap, readHistoryImages } from './attachments.ts';
import type { AgentConnection } from './connection.ts';
import { describeSlackError, slackErrorCode } from './slack-errors.ts';
import type { SlackFileFetcher, SlackInboundFile } from './files.ts';
import type { SlackAgentConfig, SlackHistoryArgs, SlackHistoryMessage, SlackWebLike } from './index.ts';

/** Uncached author names one `message.read` looks up; the rest keep their id. */
const READ_NAME_LOOKUPS = 10;

/** Slack's longest channel name. */
const CHANNEL_NAME_LIMIT = 80;

/** Slack's longest channel topic, and its longest purpose. */
const CHANNEL_TEXT_LIMIT = 250;

/** The most users one `conversations.invite` call takes. */
const CHANNEL_INVITE_LIMIT = 1000;

/** A bookmark title longer than this is cut, with an ellipsis. */
const BOOKMARK_TITLE_LIMIT = 200;

/** A bookmark link longer than this is replaced by `BOOKMARK_LINK_TOO_LONG`. */
const BOOKMARK_LINK_LIMIT = 2000;

const BOOKMARK_LINK_TOO_LONG = '(this link is longer than 2,000 characters, so it is not shown)';

/** Codes Slack answers when the token itself is refused. */
const SLACK_AUTH_ERRORS = new Set(['not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'token_expired']);

/**
 * Codes with which Slack refuses a whole `conversations.invite` without
 * inviting anyone, so `inviteToConversation` can reject and the members
 * are known unchanged. Everything else, per-person codes and failures that
 * may have partly worked included, is settled per entry instead.
 */
const SLACK_INVITE_REFUSALS = new Set([
  'not_in_channel',
  'missing_scope',
  'is_archived',
  'channel_not_found',
  'method_not_supported_for_channel_type',
  'no_user',
  'ratelimited',
  ...SLACK_AUTH_ERRORS,
]);

/**
 * What `channel_not_found` means to an app: Slack says the same for a
 * wrong id and for a private channel it can't see, and so does
 * `conversations.info`, so the sentence names both.
 */
const channelNotFoundSentence = (agentId: string, conversation: string): string =>
  `Slack found no channel ${conversation} that ${agentId}'s app can see. Check the id (copy it from the channel's link; a name won't work). `
  + 'If the id is right, the channel is private, and a member has to invite the app.';

/** What createConversations closes over: values createSlackChannelAdapter owns. */
export interface ConversationsDeps {
  log: (line: string) => void;
  warn: (line: string) => void;
  fetchFile: SlackFileFetcher;
  fileDownloadTimeoutMs: number;
  getCarried: () => SlackAgentConfig[];
  configuredAgents: Set<string>;
  displayNames: Map<string, string>;
  botIdentities: Map<string, { botUserId: string; teamId: string }>;
  displayNameFor: (connection: AgentConnection, userId: string) => Promise<string>;
  boundedDisplayName: (name: string) => string;
  nameableMentions: (connection: AgentConnection, text: string) => string[];
  plainSlackText: (connection: AgentConnection, text: string, resolved: ReadonlyMap<string, string>) => string;
  connectionFor: (agentId: string) => AgentConnection | undefined;
}

export const createConversations = ({
  log,
  warn,
  fetchFile,
  fileDownloadTimeoutMs,
  getCarried,
  configuredAgents,
  displayNames,
  botIdentities,
  displayNameFor,
  boundedDisplayName,
  nameableMentions,
  plainSlackText,
  connectionFor,
}: ConversationsDeps) => {
  /**
   * Channel or DM, as this agent's app sees a conversation, for the
   * operator's standing channel authorization (`approvals.channels`), which
   * covers channels only. Asked of Slack (`conversations.info`), never read
   * off the id: a `G…` id is a private channel or a group DM depending on
   * its age. A definite answer is kept, since a conversation never turns
   * from one into the other; a failed lookup is not, and reads as unknown,
   * so the call asks.
   */
  const conversationKinds = new Map<string, 'channel' | 'direct'>();

  const CONVERSATION_KIND_CACHE_LIMIT = 1000;

  const conversationKindFor = async (agentId: string, conversation: string): Promise<'channel' | 'direct' | undefined> => {
    const id = conversation.trim();
    const connection = connectionFor(agentId);
    if (!id || !connection) {
      return undefined;
    }
    const key = `${agentId}:${botIdentities.get(agentId)?.teamId ?? ''}:${id}`;
    const known = conversationKinds.get(key);
    if (known !== undefined) {
      return known;
    }
    let info: { id?: string; is_im?: boolean; is_mpim?: boolean; is_channel?: boolean; is_group?: boolean } | undefined;
    try {
      info = (await connection.web.conversations.info({ channel: id })).channel;
    } catch {
      return undefined;
    }
    if (!info?.id) {
      return undefined;
    }
    // A DM flag wins. Otherwise a channel only when Slack says so, by a
    // channel flag or by stating it is not a DM: a reply with none of
    // them is no proof of a channel.
    const kind = info.is_im === true || info.is_mpim === true
      ? 'direct'
      : info.is_channel === true || info.is_group === true || (info.is_im === false && info.is_mpim === false) ? 'channel' : undefined;
    if (kind !== undefined) {
      if (conversationKinds.size >= CONVERSATION_KIND_CACHE_LIMIT) {
        const oldest = conversationKinds.keys().next().value;
        if (oldest !== undefined) {
          conversationKinds.delete(oldest);
        }
      }
      conversationKinds.set(key, kind);
    }
    return kind;
  };

  /**
   * The bookmarks a first-page read returns beside the messages. Never
   * throws: a failure is a sentence for the agent, and the messages come
   * back either way.
   */
  const listBookmarks = async (
    web: SlackWebLike,
    channel: string,
  ): Promise<Pick<ConversationReadResult, 'bookmarks' | 'bookmarksUnavailable'>> => {
    if (!web.bookmarks) {
      return {};
    }
    let listed: Awaited<ReturnType<NonNullable<SlackWebLike['bookmarks']>['list']>>;
    try {
      listed = await web.bookmarks.list({ channel_id: channel });
    } catch (error) {
      const code = slackErrorCode(error);
      return {
        bookmarksUnavailable: code === 'missing_scope'
          ? 'This Slack app can\'t read bookmarks because it lacks the bookmarks:read scope. Add it to the app\'s manifest and reinstall the app.'
          : `The channel's bookmarks could not be listed (${code ?? (error instanceof Error ? error.message : String(error))}).`,
      };
    }
    const bookmarks: ConversationBookmark[] = [];
    for (const entry of Array.isArray(listed?.bookmarks) ? listed.bookmarks : []) {
      const link = typeof entry?.link === 'string' ? entry.link.trim() : '';
      if (!link) {
        continue;
      }
      const title = (typeof entry.title === 'string' && entry.title.trim()) || link;
      bookmarks.push({
        title: title.length > BOOKMARK_TITLE_LIMIT ? `${title.slice(0, BOOKMARK_TITLE_LIMIT - 1)}…` : title,
        // A cut link is a broken one, so an over-long link is not shown.
        link: link.length > BOOKMARK_LINK_LIMIT ? BOOKMARK_LINK_TOO_LONG : link,
      });
    }
    return bookmarks.length > 0 ? { bookmarks } : {};
  };

  /**
   * The conversation a session lives in, read off its id, for this
   * agent's connected app only: exactly `slack:<agent>:<this app's
   * team>:<conversation>`, or that plus one thread `ts`, the keys this
   * adapter opens sessions under. Anything longer (a delegation's
   * `:delegate:…`, an archive's `:rolledover:…`) or of another shape (a
   * schedule's) is no session of a conversation here. No lookup: the id
   * is the identity check, and only the gateway names it.
   */
  const SLACK_TS = /^\d+\.\d+$/;

  const sessionConversation = (agentId: string, sessionId: string): string | undefined => {
    const connection = connectionFor(agentId);
    if (!connection?.teamId) {
      return undefined;
    }
    const prefix = channelSessionKey({ channel: 'slack', agentId, team: connection.teamId, conversation: '' });
    if (!sessionId.startsWith(prefix)) {
      return undefined;
    }
    const [conversation, thread, ...rest] = sessionId.slice(prefix.length).split(':');
    if (!conversation || rest.length > 0 || (thread !== undefined && !SLACK_TS.test(thread))) {
      return undefined;
    }
    return conversation;
  };

  /**
   * The read side of the same boundary `resolveOutbound` draws: a channel
   * the agent's own app is a member of, public or private. DMs and group
   * DMs are refused, member or not, except the one the reading session
   * lives in (`sessionConversation`). Their only members are the people
   * in them, and a read from a conversation elsewhere — a public thread
   * above all — would carry what they said to people who were never in
   * the room; from inside, it is what they already said to this agent. A
   * thread in a channel is fine for the same reason the channel is.
   */
  const readConversation = async (request: ConversationReadRequest): Promise<ConversationReadResult> => {
    const channel = request.conversation.trim();
    if (!channel) {
      throw new Error('slack: a read needs a channel id (C…/G…).');
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so ${channel} cannot be read.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot read Slack at all.`);
    }
    let info: { id?: string; is_member?: boolean; is_im?: boolean; is_mpim?: boolean } | undefined;
    try {
      info = (await connection.web.conversations.info({ channel })).channel;
    } catch (error) {
      throw new Error(
        `slack: ${request.agentId}'s app cannot see ${channel} (${error instanceof Error ? error.message : String(error)}). `
        + 'Use the channel id, not a name.',
      );
    }
    if (!info?.id) {
      throw new Error(`slack: ${request.agentId}'s app cannot see a conversation ${channel}.`);
    }
    const direct = info.is_im === true || info.is_mpim === true;
    if (direct && (request.sessionId === undefined || sessionConversation(request.agentId, request.sessionId) !== info.id)) {
      throw new Error(`slack: ${channel} is a direct message this conversation is not in, and a direct message is read only from inside it. Approval cannot unlock this; read a channel instead.`);
    }
    // A one-to-one IM states no membership; the session living in it is
    // the proof. A group DM does say, and an app that left one cannot read
    // it however its stale session is named.
    if (info.is_im !== true && info.is_member !== true) {
      throw new Error(`slack: ${request.agentId}'s app is not a member of ${channel} — invite it there before it can read.`);
    }
    const { history, replies } = connection.web.conversations;
    const fetchPage = request.thread !== undefined
      ? (replies ? (args: SlackHistoryArgs) => replies({ ...args, ts: request.thread as string }) : undefined)
      : history;
    if (!fetchPage) {
      throw new Error(`slack: this Slack client cannot read ${request.thread !== undefined ? 'threads' : 'channel history'}.`);
    }
    // On the first page of the top level only, so paging costs no extra
    // calls, and only once the checks above have said the read may happen.
    // Asked beside the history, and settled without throwing.
    const listing = request.thread === undefined && request.after === undefined && request.before === undefined
      ? listBookmarks(connection.web, info.id)
      : undefined;
    const base: SlackHistoryArgs = {
      channel: info.id,
      inclusive: false,
      ...(request.after !== undefined ? { oldest: request.after } : {}),
      ...(request.before !== undefined ? { latest: request.before } : {}),
    };
    const raw: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    let more = false;
    do {
      const page = await fetchPage({ ...base, limit: Math.min(200, request.limit - raw.length), ...(cursor ? { cursor } : {}) });
      raw.push(...(page.messages ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
      more = cursor !== undefined || page.has_more === true;
    } while (cursor && raw.length < request.limit);
    if (raw.length > request.limit) {
      raw.length = request.limit;
      more = true;
    }
    // History rarely embeds profiles, so names mostly come from users.info.
    // Cached names are free; at most READ_NAME_LOOKUPS uncached people —
    // authors and the mentions in their text together — are looked up per
    // read, at once, and the rest keep their id, so a read of many strangers
    // never waits through a rate limit one call at a time.
    const lookups = new Map<string, Promise<string>>();
    let fresh = 0;
    const want = (user: string): void => {
      if (lookups.has(user)) {
        return;
      }
      const cached = displayNames.get(`${connection.teamId}:${user}`);
      if (cached) {
        lookups.set(user, Promise.resolve(cached));
      } else if (fresh < READ_NAME_LOOKUPS) {
        fresh += 1;
        lookups.set(user, displayNameFor(connection, user));
      }
    };
    for (const message of raw) {
      const user = message.user;
      if (user && !message.user_profile?.display_name && !message.user_profile?.real_name) {
        want(user);
      }
    }
    for (const message of raw) {
      for (const id of nameableMentions(connection, message.text ?? '')) {
        want(id);
      }
    }
    const names = new Map<string, string>();
    for (const [user, name] of lookups) {
      names.set(user, await name);
    }
    const messages: ConversationMessage[] = [];
    const sources: Array<{ message: ConversationMessage; files: SlackInboundFile[] }> = [];
    for (const message of raw) {
      if (!message.ts) {
        continue;
      }
      const author = message.user ?? message.bot_id ?? 'unknown';
      const name = message.user_profile?.display_name
        || message.user_profile?.real_name
        || message.bot_profile?.name
        || message.username
        || (message.user ? names.get(message.user) : undefined);
      const at = Number.parseFloat(message.ts);
      const files = (message.files ?? []).map((file) => file.name ?? file.title ?? file.id ?? 'file');
      const read: ConversationMessage = {
        id: message.ts,
        author,
        text: plainSlackText(connection, message.text ?? '', names),
        ...(name && name !== author ? { authorName: boundedDisplayName(name) } : {}),
        ...(Number.isFinite(at) ? { at: new Date(at * 1000).toISOString() } : {}),
        ...(message.thread_ts && message.thread_ts !== message.ts ? { thread: message.thread_ts } : {}),
        ...(message.reply_count ? { replies: message.reply_count } : {}),
        ...(files.length > 0 ? { files } : {}),
      };
      messages.push(read);
      if (message.files !== undefined && message.files.length > 0) {
        sources.push({ message: read, files: message.files });
      }
    }
    const imageCap = historyImageCap(request.images);
    if (imageCap !== undefined) {
      await readHistoryImages(sources, imageCap, connection.config.botToken, fetchFile, fileDownloadTimeoutMs, warn);
    }
    return { messages, more, ...(listing ? await listing : {}) };
  };

  /**
   * Creates a channel with the asking agent's own app — `channel.create`.
   * Everything Slack would refuse once the channel exists is refused here
   * first, so a bad request leaves no channel behind. After the create
   * nothing throws: a topic, purpose or invitation that fails is reported,
   * and the channel stays. Slack names are unique, so an agent that
   * retries a create gets `name_taken`, never a second channel.
   */
  const createConversation = async (request: ConversationCreateRequest): Promise<ConversationCreateResult> => {
    const name = request.name.trim().replace(/^#/, '');
    if (!name) {
      throw new Error('slack: a channel needs a name.');
    }
    if (!/^[a-z0-9_-]+$/.test(name)) {
      throw new Error(`slack: "${name}" can't be a channel name: Slack names use only lowercase letters, numbers, hyphens and underscores. Nothing was created.`);
    }
    if (name.length > CHANNEL_NAME_LIMIT) {
      throw new Error(`slack: a channel name is at most ${CHANNEL_NAME_LIMIT} characters; this one is ${name.length}. Nothing was created.`);
    }
    for (const field of ['topic', 'purpose'] as const) {
      const length = [...(request[field] ?? '')].length;
      if (length > CHANNEL_TEXT_LIMIT) {
        throw new Error(`slack: the ${field} is ${length} characters; Slack allows ${CHANNEL_TEXT_LIMIT}. Nothing was created.`);
      }
    }
    const invite = request.invite ?? [];
    if (invite.length > CHANNEL_INVITE_LIMIT) {
      throw new Error(`slack: that invites ${invite.length.toLocaleString('en-US')} people; Slack invites at most ${CHANNEL_INVITE_LIMIT.toLocaleString('en-US')} at once. Nothing was created.`);
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so it cannot create a channel.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot create a Slack channel.`);
    }
    const { create, setTopic, setPurpose, invite: inviteUsers } = connection.web.conversations;
    if (!create || !setTopic || !setPurpose || !inviteUsers) {
      throw new Error('slack: this Slack client cannot create channels.');
    }
    // Who each entry is, before anything exists. The creating app is a
    // member already, so naming it counts as invited.
    const { own, notInvited, toInvite } = resolveInvitees(connection, request.agentId, invite);
    const invited = [...own];

    const kind = request.private === true ? 'private' : 'public';
    let created: Awaited<ReturnType<typeof create>>;
    try {
      created = await create({ name, is_private: request.private === true });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'missing_scope') {
        throw new Error(`slack: ${request.agentId}'s Slack app can't create ${kind} channels because it lacks the ${request.private === true ? 'groups:write' : 'channels:manage'} scope. Add it to the app's manifest and reinstall the app.`);
      }
      if (code === 'name_taken') {
        throw new Error(`slack: there is already a channel named #${name} in this workspace, perhaps archived. Pick another name, or use that channel.`);
      }
      throw new Error(`slack: Slack could not create #${name} (${code ?? (error instanceof Error ? error.message : String(error))}).`);
    }
    const conversation = created.channel?.id;
    if (!conversation) {
      throw new Error(`slack: Slack answered the create of #${name} without a channel id, so whether it exists is unknown. Read the channel list before trying again.`);
    }

    const notSet: Array<{ field: 'topic' | 'purpose'; reason: string }> = [];
    if (request.topic) {
      await setTopic({ channel: conversation, topic: request.topic })
        .catch((error: unknown) => notSet.push({ field: 'topic', reason: `Slack did not set the topic (${describeSlackError(error)}).` }));
    }
    if (request.purpose) {
      await setPurpose({ channel: conversation, purpose: request.purpose })
        .catch((error: unknown) => notSet.push({ field: 'purpose', reason: `Slack did not set the purpose (${describeSlackError(error)}).` }));
    }

    // The channel exists now, so every code is settled per entry and none
    // turns into a rejection the agent would retry into a second channel.
    const settled = await inviteAtSlack(connection, inviteUsers, conversation, toInvite);
    invited.push(...settled.invited);
    notInvited.push(...settled.notInvited);
    sortByRequest(invite, invited, notInvited);
    return { conversation, name: created.channel?.name ?? name, invited, notInvited, notSet };
  };

  /**
   * Who each invite entry is, before Slack is asked: agents on this host
   * become the user their app posts as, in the same workspace only. `own`
   * holds the entries that are the asking app itself (the agent, or one
   * sharing its bot user), which no invitation can add.
   */
  const resolveInvitees = (connection: AgentConnection, agentId: string, invite: string[]): {
    own: string[];
    notInvited: Array<{ who: string; reason: string }>;
    toInvite: Map<string, string>;
  } => {
    const own: string[] = [];
    const notInvited: Array<{ who: string; reason: string }> = [];
    const toInvite = new Map<string, string>();
    for (const who of invite) {
      const identity = botIdentities.get(who);
      if (who === agentId || identity?.botUserId === connection.botUserId) {
        own.push(who);
      } else if (configuredAgents.has(who) && !identity?.botUserId) {
        notInvited.push({ who, reason: `Agent ${who}'s Slack app is not connected, so its Slack user is unknown.` });
      } else if (identity) {
        if (identity.teamId !== connection.teamId) {
          notInvited.push({ who, reason: `Agent ${who}'s Slack app is in another Slack workspace.` });
        } else {
          toInvite.set(who, identity.botUserId);
        }
      } else if (/^[UW][A-Z0-9]+$/.test(who)) {
        toInvite.set(who, who);
      } else {
        notInvited.push({ who, reason: 'Not a Slack user id (U… or W…) or an agent with a Slack app on this host.' });
      }
    }
    return { own, notInvited, toInvite };
  };

  /**
   * Sends one `conversations.invite`, force on so a bad id cannot stop the
   * good ones, and settles each entry of `toInvite` (entry -> Slack user).
   * Slack's per-id failures name who was refused, and `already_in_channel`
   * counts as invited. A failed call that does not name everyone leaves
   * the rest to the channel's members, and who cannot be checked is never
   * claimed. A call Slack refused with a code `refusesWhole` accepts stops
   * there, before any members check, with nobody settled and the code in
   * `refusedWith` for the caller to reject on. Without `refusesWhole`
   * every code is settled per entry.
   */
  const inviteAtSlack = async (
    connection: AgentConnection,
    inviteUsers: NonNullable<SlackWebLike['conversations']['invite']>,
    conversation: string,
    toInvite: Map<string, string>,
    refusesWhole: (code: string) => boolean = () => false,
  ): Promise<{ invited: string[]; notInvited: Array<{ who: string; reason: string }>; refusedWith?: string }> => {
    const invited: string[] = [];
    const notInvited: Array<{ who: string; reason: string }> = [];
    if (toInvite.size === 0) {
      return { invited, notInvited };
    }
    // Slack's per-id failures, by user id: on the answer, or on the error
    // the SDK throws for an ok: false answer.
    const refusedOf = (errors: unknown): Map<string, string> => new Map(
      (Array.isArray(errors) ? errors : []).flatMap((entry: { user?: unknown; error?: unknown }) =>
        typeof entry?.user === 'string' && typeof entry.error === 'string' ? [[entry.user, entry.error] as const] : []),
    );
    let refused: Map<string, string>;
    let failure: string | undefined;
    try {
      refused = refusedOf((await inviteUsers({ channel: conversation, users: [...new Set(toInvite.values())].join(','), force: true })).errors);
    } catch (error) {
      const code = slackErrorCode(error);
      if (code !== undefined && refusesWhole(code)) {
        return { invited, notInvited, refusedWith: code };
      }
      refused = refusedOf((error as { data?: { errors?: unknown } } | undefined)?.data?.errors);
      failure = describeSlackError(error);
    }
    // A failed call that does not name everyone leaves the rest unknown,
    // so the channel's members decide; who cannot be checked is not claimed.
    let members: Set<string> | undefined;
    let membersFailure: string | undefined;
    if (failure !== undefined && [...toInvite.values()].some((user) => !refused.has(user))) {
      try {
        members = new Set();
        let cursor: string | undefined;
        do {
          const page = await connection.web.conversations.members({ channel: conversation, limit: 1000, ...(cursor ? { cursor } : {}) });
          for (const member of page.members ?? []) {
            members.add(member);
          }
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor);
      } catch (error) {
        members = undefined;
        membersFailure = describeSlackError(error);
      }
    }
    for (const [who, user] of toInvite) {
      const code = refused.get(user);
      if (code === 'already_in_channel' || (code === undefined && (failure === undefined || members?.has(user)))) {
        invited.push(who);
      } else if (code !== undefined || members !== undefined) {
        notInvited.push({ who, reason: `Slack did not invite them (${code ?? failure}).` });
      } else {
        notInvited.push({
          who,
          reason: `The invitation failed (${failure}) and the channel's members could not be checked (${membersFailure}), so they may or may not have been added.`,
        });
      }
    }
    return { invited, notInvited };
  };

  /** Puts both lists back in the order the caller named the entries. */
  const sortByRequest = (invite: string[], invited: string[], notInvited: Array<{ who: string; reason: string }>): void => {
    const order = new Map(invite.map((who, index) => [who, index]));
    const byRequest = (left: string, right: string): number => (order.get(left) ?? 0) - (order.get(right) ?? 0);
    invited.sort(byRequest);
    notInvited.sort((left, right) => byRequest(left.who, right.who));
  };

  /**
   * Joins an existing public channel with the asking agent's own app —
   * `channel.join`. Anything it did not join rejects with a sentence; an
   * answer that leaves it unknown says so, and that a retry is safe,
   * since Slack treats a second join as a no-op.
   */
  const joinConversation = async (request: ConversationJoinRequest): Promise<ConversationJoinResult> => {
    const conversation = request.conversation.trim();
    if (!conversation) {
      throw new Error('slack: joining needs a channel id (C…).');
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so it cannot join ${conversation}.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot join a Slack channel.`);
    }
    const { join } = connection.web.conversations;
    if (!join) {
      throw new Error('slack: this Slack client cannot join channels.');
    }
    const agent = request.agentId;
    let joined: Awaited<ReturnType<typeof join>>;
    try {
      joined = await join({ channel: conversation });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === undefined || code === 'internal_error' || code === 'fatal_error') {
        throw new Error(`slack: Slack's answer left it unknown whether ${agent}'s app joined ${conversation} (${describeSlackError(error)}). Trying again is safe: joining a channel twice changes nothing.`);
      }
      if (code === 'missing_scope') {
        throw new Error(`slack: ${agent}'s Slack app can't join channels on its own because it lacks the channels:join scope. Add it to the app's manifest and reinstall the app.`);
      }
      if (code === 'method_not_supported_for_channel_type') {
        throw new Error(`slack: ${conversation} isn't a public channel. Slack never lets an app join a private channel on its own: a member has to invite the app.`);
      }
      if (code === 'channel_not_found') {
        throw new Error(`slack: ${channelNotFoundSentence(agent, conversation)}`);
      }
      if (code === 'is_archived') {
        throw new Error(`slack: ${conversation} is archived, so it can't be joined.`);
      }
      if (code === 'too_many_members') {
        throw new Error(`slack: ${conversation} is at Slack's member limit, so ${agent}'s app can't join it.`);
      }
      if (code === 'ratelimited') {
        throw new Error(`slack: Slack is rate-limiting ${agent}'s app; try joining ${conversation} again later.`);
      }
      if (SLACK_AUTH_ERRORS.has(code)) {
        throw new Error(`slack: Slack refused ${agent}'s app token (${code}). Reinstall the app or replace its bot token.`);
      }
      throw new Error(`slack: Slack did not let ${agent}'s app join ${conversation} (${code}).`);
    }
    const warnings = [joined.warning, ...(joined.response_metadata?.warnings ?? [])];
    return { conversation: joined.channel?.id ?? conversation, alreadyMember: warnings.includes('already_in_channel') };
  };

  /**
   * Invites people and agents to an existing channel with the asking
   * agent's own app — `channel.invite`. It rejects only when nobody was
   * invited: a request refused before Slack is asked, or a whole call Slack
   * refused without acting. Everything else is settled per entry by the
   * same code `createConversation` uses.
   */
  const inviteToConversation = async (request: ConversationInviteRequest): Promise<ConversationInviteResult> => {
    const conversation = request.conversation.trim();
    if (!conversation) {
      throw new Error('slack: an invitation needs a channel id (C…).');
    }
    const invite = request.invite;
    if (invite.length === 0) {
      throw new Error('slack: an invitation needs at least one person or agent to invite.');
    }
    if (invite.length > CHANNEL_INVITE_LIMIT) {
      throw new Error(`slack: that invites ${invite.length.toLocaleString('en-US')} people; Slack invites at most ${CHANNEL_INVITE_LIMIT.toLocaleString('en-US')} at once. Nobody was invited.`);
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so it cannot invite anyone to ${conversation}.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot invite anyone to a Slack channel.`);
    }
    const inviteUsers = connection.web.conversations.invite;
    if (!inviteUsers) {
      throw new Error('slack: this Slack client cannot invite people to channels.');
    }
    const agent = request.agentId;
    const { own, notInvited, toInvite } = resolveInvitees(connection, agent, invite);
    for (const who of own) {
      notInvited.push({ who, reason: 'That is your own app, which can\'t invite itself. To join a public channel, use channel.join.' });
    }
    const settled = await inviteAtSlack(connection, inviteUsers, conversation, toInvite, (code) => SLACK_INVITE_REFUSALS.has(code));
    if (settled.refusedWith !== undefined) {
      const code = settled.refusedWith;
      const why = code === 'not_in_channel'
        ? `${agent}'s app isn't in ${conversation}, so it can't invite anyone there. For a public channel, join it first with channel.join; for a private one, a member has to invite the app.`
        : code === 'channel_not_found'
          ? channelNotFoundSentence(agent, conversation)
          : code === 'missing_scope'
            ? `${agent}'s Slack app lacks the scope to invite people: channels:write.invites for a public channel or groups:write.invites for a private one (channels:manage or groups:write also work). Add it to the app's manifest and reinstall the app.`
            : code === 'is_archived'
              ? `${conversation} is archived, so nobody can be invited to it.`
              : code === 'method_not_supported_for_channel_type'
                ? `${conversation} is a direct message or another conversation Slack doesn't allow invitations to.`
                : code === 'ratelimited'
                  ? `Slack is rate-limiting ${agent}'s app; try the invitation again later.`
                  : SLACK_AUTH_ERRORS.has(code)
                    ? `Slack refused ${agent}'s app token (${code}). Reinstall the app or replace its bot token.`
                    : `Slack did not invite anyone to ${conversation} (${code}).`;
      throw new Error(`slack: ${why} Nobody was invited.`);
    }
    const invited = settled.invited;
    notInvited.push(...settled.notInvited);
    sortByRequest(invite, invited, notInvited);
    return { invited, notInvited };
  };

  /**
   * Other agents on this host whose Slack app is this agent's: the same
   * bot token configured (connected or not), or the same bot user in the
   * same workspace. Slack's `creator` names the app's bot user, so it
   * can't tell those agents' channels apart. This sees only this process;
   * one app per agent is the supported setup (see the README).
   */
  const agentsSharingAppWith = (connection: AgentConnection): string[] => {
    const agentId = connection.config.agentId;
    const sharing = new Set<string>();
    for (const other of getCarried()) {
      if (other.agentId !== agentId && other.botToken === connection.config.botToken) {
        sharing.add(other.agentId);
      }
    }
    for (const [other, identity] of botIdentities) {
      if (other !== agentId && identity.botUserId !== '' && identity.botUserId === connection.botUserId && identity.teamId === connection.teamId) {
        sharing.add(other);
      }
    }
    return [...sharing];
  };

  /**
   * Archives a channel the asking agent's own app created — what
   * `channel.archive` runs on. Everything it refuses is refused before
   * Slack is asked to archive: an id Slack can't show this app, a direct
   * message, a channel another user or app created, an app other agents
   * here share, a channel shared outside the workspace. Slack keeps who
   * created a channel and whether it is archived, so nothing is stored
   * here and the rule holds across restarts and hosts. Refusals name the
   * channel by id only: its name is whatever its members typed.
   */
  const archiveConversation = async (request: ConversationArchiveRequest): Promise<ConversationArchiveResult> => {
    const conversation = request.conversation.trim();
    if (!conversation) {
      throw new Error('slack: archiving needs a channel id (C…).');
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so it cannot archive ${conversation}.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot archive a Slack channel.`);
    }
    const { archive } = connection.web.conversations;
    if (!archive) {
      throw new Error('slack: this Slack client cannot archive channels.');
    }
    const agent = request.agentId;
    const nothing = 'Nothing was archived.';
    const sharing = agentsSharingAppWith(connection);
    if (sharing.length > 0) {
      throw new Error(`slack: ${agent}'s Slack app is also ${sharing.map((other) => `${other}'s`).join(' and ')} here, so Stratus can't tell which agent created ${conversation}. `
        + `Give each agent its own Slack app. A person can archive it in Slack. ${nothing}`);
    }
    let info: Awaited<ReturnType<typeof connection.web.conversations.info>>['channel'];
    try {
      info = (await connection.web.conversations.info({ channel: conversation })).channel;
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'channel_not_found') {
        throw new Error(`slack: ${channelNotFoundSentence(agent, conversation)} Either way, ${agent} can only archive channels its own app created. ${nothing}`);
      }
      if (code === 'ratelimited') {
        throw new Error(`slack: Slack is rate-limiting ${agent}'s app; try archiving ${conversation} again later. ${nothing}`);
      }
      if (code !== undefined && SLACK_AUTH_ERRORS.has(code)) {
        throw new Error(`slack: Slack refused ${agent}'s app token (${code}). Reinstall the app or replace its bot token. ${nothing}`);
      }
      throw new Error(`slack: Slack could not tell ${agent}'s app who created ${conversation} (${describeSlackError(error)}). ${nothing}`);
    }
    if (info?.is_im === true || info?.is_mpim === true) {
      throw new Error(`slack: ${conversation} is a direct message, and only channels can be archived. ${nothing}`);
    }
    const creator = info?.creator ?? '';
    if (creator === '' || connection.botUserId === '' || creator !== connection.botUserId) {
      throw new Error(`slack: ${agent}'s app didn't create ${conversation}: another user or app did, so ${agent} can't archive it. A person can archive it in Slack. ${nothing}`);
    }
    if (info?.is_shared === true || info?.is_ext_shared === true || info?.is_org_shared === true || info?.is_pending_ext_shared === true) {
      throw new Error(`slack: ${conversation} is shared with another workspace or organization, so archiving it would reach people outside this one. A person can archive it in Slack. ${nothing}`);
    }
    if (info?.is_archived === true) {
      return { conversation, alreadyArchived: true };
    }
    try {
      await archive({ channel: conversation });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'already_archived') {
        return { conversation, alreadyArchived: true };
      }
      warn(`slack: ${agent} could not archive ${conversation} (${describeSlackError(error)})`);
      if (code === undefined || code === 'internal_error' || code === 'fatal_error') {
        throw new Error(`slack: Slack's answer left it unknown whether ${agent}'s app archived ${conversation} (${describeSlackError(error)}). It may be archived. Trying again is safe: archiving a channel twice changes nothing.`);
      }
      const isPrivate = info?.is_private === true || info?.is_group === true;
      const why = code === 'missing_scope'
        ? `${agent}'s Slack app can't archive ${isPrivate ? 'private' : 'public'} channels because it lacks the ${isPrivate ? 'groups:write' : 'channels:manage'} scope. Add it to the app's manifest and reinstall the app.`
        : code === 'not_in_channel'
          ? `${agent}'s app is no longer a member of ${conversation}, so it can't archive it. A member has to add the app back first.`
          : code === 'restricted_action'
            ? `This workspace limits who can archive channels, so ${agent}'s app can't archive ${conversation}. A person has to do it in Slack.`
            : code === 'ratelimited'
              ? `Slack is rate-limiting ${agent}'s app; try archiving ${conversation} again later.`
              : code === 'channel_not_found'
                ? channelNotFoundSentence(agent, conversation)
                : SLACK_AUTH_ERRORS.has(code)
                  ? `Slack refused ${agent}'s app token (${code}). Reinstall the app or replace its bot token.`
                  : `Slack did not let ${agent}'s app archive ${conversation} (${code}).`;
      throw new Error(`slack: ${why} ${nothing}`);
    }
    log(`slack: ${agent} archived ${conversation}`);
    return { conversation, alreadyArchived: false };
  };

  return {
    conversationKindFor,
    sessionConversation,
    readConversation,
    createConversation,
    joinConversation,
    inviteToConversation,
    archiveConversation,
  };
};

export type Conversations = ReturnType<typeof createConversations>;
