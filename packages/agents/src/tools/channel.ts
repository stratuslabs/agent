import type { JsonObject, Session, Tool } from '@stratusagent/core';

export const CHANNEL_CREATE_TOOL_NAME = 'channel.create';

/**
 * Creates one conversation through the agent's own channel app. The
 * gateway implements it over the channel contract's `createConversation`,
 * structurally mirrored here the way `ConversationReader` mirrors
 * `readConversation`; rejecting is how a channel says it will not.
 */
export type ConversationCreator = (input: {
  agentId: string;
  /** The channel kind, e.g. `slack`. */
  channel: string;
  name: string;
  private?: boolean;
  topic?: string;
  purpose?: string;
  /** Channel-native user ids, or agent ids the channel resolves to their app. */
  invite?: string[];
}) => Promise<{
  conversation: string;
  name: string;
  invited: string[];
  notInvited: Array<{ who: string; reason: string }>;
  notSet: Array<{ field: 'topic' | 'purpose'; reason: string }>;
}>;

const optionalText = (input: JsonObject, key: string): string | undefined => {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${CHANNEL_CREATE_TOOL_NAME}: "${key}" must be a string when given.`);
  }
  return value.trim() || undefined;
};

/**
 * Create a channel and invite people and other agents to it, so an agent
 * can set up a client or project room without a person doing it by hand.
 *
 * `gated`, like `message.send`: a new channel and its invitations are seen
 * by everyone invited, and a channel cannot be taken back by the agent.
 * There is no destination to judge by before the channel exists, so a
 * durable grant is a standing yes to creating channels. The channel's own
 * app does the work with its own token, which never reaches the agent; the
 * channel decides what its app may create.
 */
export const createChannelCreateTool = (create: ConversationCreator): Tool => ({
  name: CHANNEL_CREATE_TOOL_NAME,
  description: 'Create a channel through your own app, optionally private, with a topic and purpose, and invite people and other agents to it. '
    + 'invite takes the channel\'s user ids (for Slack, U…) and other agents\' ids on this host, which resolve to their apps. '
    + 'Returns the new conversation id. The channel is kept even if some invites or the topic fail: '
    + 'notInvited and notSet say what did not happen and why, so report those rather than retrying the create. '
    + 'For Slack, names are lowercase letters, numbers, hyphens and underscores, at most 80 characters.',
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel kind to create it in, e.g. "slack".' },
      name: { type: 'string', description: 'The new channel\'s name, without a leading #.' },
      private: { type: 'boolean', description: 'Create a private channel. Public by default.' },
      topic: { type: 'string', description: 'The channel\'s topic.' },
      purpose: { type: 'string', description: 'The channel\'s purpose (its description).' },
      invite: {
        type: 'array',
        items: { type: 'string' },
        description: 'Who to invite: user ids, or agent ids on this host. Your own app is already a member.',
      },
    },
    required: ['channel', 'name'],
  },
  async execute(input: JsonObject, session: Session) {
    const channel = typeof input.channel === 'string' ? input.channel.trim() : '';
    if (!channel) {
      throw new Error(`${CHANNEL_CREATE_TOOL_NAME} requires "channel", the channel kind (e.g. "slack").`);
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw new Error(`${CHANNEL_CREATE_TOOL_NAME} requires a non-empty "name".`);
    }
    if (input.private !== undefined && typeof input.private !== 'boolean') {
      throw new Error(`${CHANNEL_CREATE_TOOL_NAME}: "private" must be true or false.`);
    }
    const topic = optionalText(input, 'topic');
    const purpose = optionalText(input, 'purpose');
    let invite: string[] | undefined;
    if (input.invite !== undefined && input.invite !== null) {
      const raw = input.invite;
      if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
        throw new Error(`${CHANNEL_CREATE_TOOL_NAME}: "invite" must be a list of non-empty ids.`);
      }
      const unique = [...new Set((raw as string[]).map((entry) => entry.trim()))];
      invite = unique.length > 0 ? unique : undefined;
    }
    const result = await create({
      agentId: session.agent.id,
      channel,
      name,
      ...(input.private === true ? { private: true } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      ...(invite !== undefined ? { invite } : {}),
    });
    return {
      created: true,
      channel,
      conversation: result.conversation,
      name: result.name,
      invited: [...result.invited],
      notInvited: result.notInvited.map(({ who, reason }) => ({ who, reason })),
      notSet: result.notSet.map(({ field, reason }) => ({ field, reason })),
    } as JsonObject;
  },
});

export const CHANNEL_JOIN_TOOL_NAME = 'channel.join';
export const CHANNEL_INVITE_TOOL_NAME = 'channel.invite';

/**
 * Joins one existing conversation with the agent's own channel app, over
 * the channel contract's `joinConversation`, mirrored here like
 * `ConversationCreator`.
 */
export type ConversationJoiner = (input: {
  agentId: string;
  /** The channel kind, e.g. `slack`. */
  channel: string;
  conversation: string;
}) => Promise<{ conversation: string; alreadyMember: boolean }>;

/**
 * Invites people to one existing conversation through the agent's own
 * channel app, over the channel contract's `inviteToConversation`.
 * Rejecting means nobody was invited.
 */
export type ConversationInviter = (input: {
  agentId: string;
  /** The channel kind, e.g. `slack`. */
  channel: string;
  conversation: string;
  /** Channel-native user ids, or agent ids the channel resolves to their app. */
  invite: string[];
}) => Promise<{ invited: string[]; notInvited: Array<{ who: string; reason: string }> }>;

const requiredText = (tool: string, input: JsonObject, key: string, what: string): string => {
  const value = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
  if (!value) {
    throw new Error(`${tool} requires "${key}", ${what}.`);
  }
  return value;
};

/**
 * Join an existing public channel with the agent's own app, so it can read
 * the channel and be mentioned there without a person adding it.
 *
 * `gated`, like `channel.create`: Slack starts sending the agent the
 * channel's messages. Who gets a turn does not change, since principals
 * and admit still decide. The result names the channel by id only: its
 * name and topic are whatever its members typed.
 */
export const createChannelJoinTool = (join: ConversationJoiner): Tool => ({
  name: CHANNEL_JOIN_TOOL_NAME,
  description: 'Join an existing public channel with your own app, by its id (for Slack, C…, from the channel\'s link or a message). '
    + 'Joining a channel you are already in changes nothing and says alreadyMember. '
    + 'An app can never join a private channel on its own: a member has to invite it.',
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel kind, e.g. "slack".' },
      conversation: { type: 'string', description: 'The id of the channel to join (for Slack, C…), not its name.' },
    },
    required: ['channel', 'conversation'],
  },
  async execute(input: JsonObject, session: Session) {
    const channel = requiredText(CHANNEL_JOIN_TOOL_NAME, input, 'channel', 'the channel kind (e.g. "slack")');
    const conversation = requiredText(CHANNEL_JOIN_TOOL_NAME, input, 'conversation', 'the id of the channel to join');
    const result = await join({ agentId: session.agent.id, channel, conversation });
    return { joined: true, channel, conversation: result.conversation, alreadyMember: result.alreadyMember === true } as JsonObject;
  },
});

/**
 * Invite people and other agents to a channel that already exists, through
 * the agent's own app, which has to be in it.
 *
 * `gated`, like `channel.create`: everyone invited to a private channel can
 * read its history. The approval prompt shows the channel and each
 * invitee. A rejection means nobody was invited; anything else comes back
 * with who was and who was not.
 */
export const createChannelInviteTool = (invite: ConversationInviter): Tool => ({
  name: CHANNEL_INVITE_TOOL_NAME,
  description: 'Invite people and other agents to an existing channel your own app is in, by the channel\'s id (for Slack, C…). '
    + 'invite takes the channel\'s user ids (for Slack, U…) and other agents\' ids on this host, which resolve to their apps. '
    + 'notInvited says who was not added and why; report those rather than retrying everyone. '
    + 'If your app is not in the channel, join it first with channel.join (public channels only).',
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel kind, e.g. "slack".' },
      conversation: { type: 'string', description: 'The id of the channel to invite them to (for Slack, C…), not its name.' },
      invite: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Who to invite: user ids, or agent ids on this host.',
      },
    },
    required: ['channel', 'conversation', 'invite'],
  },
  async execute(input: JsonObject, session: Session) {
    const channel = requiredText(CHANNEL_INVITE_TOOL_NAME, input, 'channel', 'the channel kind (e.g. "slack")');
    const conversation = requiredText(CHANNEL_INVITE_TOOL_NAME, input, 'conversation', 'the id of the channel to invite them to');
    const raw = input.invite;
    if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
      throw new Error(`${CHANNEL_INVITE_TOOL_NAME}: "invite" must list at least one user or agent id.`);
    }
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      throw new Error(`${CHANNEL_INVITE_TOOL_NAME}: "invite" must be a list of non-empty ids.`);
    }
    const unique = [...new Set((raw as string[]).map((entry) => entry.trim()))];
    const result = await invite({ agentId: session.agent.id, channel, conversation, invite: unique });
    return {
      channel,
      conversation,
      invited: [...result.invited],
      notInvited: result.notInvited.map(({ who, reason }) => ({ who, reason })),
    } as JsonObject;
  },
});

export const CHANNEL_ARCHIVE_TOOL_NAME = 'channel.archive';

/**
 * Archives one conversation the agent's own channel app created, over the
 * channel contract's `archiveConversation`. It takes the asking session
 * too, because the gateway refuses to archive the conversation the work
 * was asked from, and only the session says which one that is. Rejecting
 * means the conversation was not archived, or that it is unknown.
 */
export type ConversationArchiver = (
  input: {
    agentId: string;
    /** The channel kind, e.g. `slack`. */
    channel: string;
    conversation: string;
  },
  session: Session,
) => Promise<{ conversation: string; alreadyArchived: boolean }>;

/**
 * Archive a channel the agent's own app created, so test and one-off
 * channels don't stay open until a person cleans them up.
 *
 * `gated`, like `channel.create`: archiving takes the channel out of its
 * members' sidebars, and the agent can't undo it. The channel decides what
 * its app may archive, and Slack's refuses anything the app didn't create.
 * Nothing is deleted: a person can unarchive it. The result names the
 * channel by id only, since members can rename a channel after it is made.
 */
/**
 * A refusal the host can tell before anyone is asked about a
 * `channel.archive` call (the conversation the work was asked from), so
 * nobody approves an archive that is bound to fail. Undefined when it has
 * nothing to say; the archiver still refuses the same call itself.
 */
export type ConversationArchiveRefusal = (
  input: { agentId: string; channel: string; conversation: string },
  session: Session,
) => Promise<string | undefined>;

export const createChannelArchiveTool = (
  archive: ConversationArchiver,
  options: { refusalFor?: ConversationArchiveRefusal } = {},
): Tool => ({
  name: CHANNEL_ARCHIVE_TOOL_NAME,
  description: 'Archive a channel your own app created (for example with channel.create), by its id (for Slack, C…). '
    + 'Channels another user or app created are refused, and so is the conversation you were asked from. '
    + 'You can\'t undo an archive: messages are kept, and a person can unarchive the channel in Slack. '
    + 'Archiving a channel that is already archived changes nothing and says alreadyArchived.',
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel kind, e.g. "slack".' },
      conversation: { type: 'string', description: 'The id of the channel to archive (for Slack, C…), not its name.' },
    },
    required: ['channel', 'conversation'],
  },
  ...(options.refusalFor !== undefined
    ? {
        async refusalFor(input: JsonObject, session: Session) {
          const channel = typeof input.channel === 'string' ? input.channel.trim() : '';
          const conversation = typeof input.conversation === 'string' ? input.conversation.trim() : '';
          return channel && conversation ? options.refusalFor?.({ agentId: session.agent.id, channel, conversation }, session) : undefined;
        },
      }
    : {}),
  async execute(input: JsonObject, session: Session) {
    const channel = requiredText(CHANNEL_ARCHIVE_TOOL_NAME, input, 'channel', 'the channel kind (e.g. "slack")');
    const conversation = requiredText(CHANNEL_ARCHIVE_TOOL_NAME, input, 'conversation', 'the id of the channel to archive');
    const result = await archive({ agentId: session.agent.id, channel, conversation }, session);
    return { archived: true, channel, conversation: result.conversation, alreadyArchived: result.alreadyArchived === true } as JsonObject;
  },
});
