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
