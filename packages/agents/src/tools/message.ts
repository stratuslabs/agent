import type { JsonObject, Session, Tool } from '@stratusagent/core';
import {
  type ScheduleDestination,
  canonicalDestination,
  parseDestinationInput,
  DESTINATION_PARAMETER,
} from '../schedules.ts';

export const MESSAGE_SEND_TOOL_NAME = 'message.send';

/**
 * Delivers one outbound message through the agent's channel. The gateway
 * implements it over the channel contract's `resolveOutbound`; rejecting is
 * the way to say a destination cannot be served.
 */
export type OutboundMessenger = (input: {
  agentId: string;
  destination: ScheduleDestination;
  text: string;
}) => Promise<void>;

/**
 * Post to a channel or DM outside the current conversation — what makes a
 * scheduled turn observable.
 *
 * `gated`, and deliberately not `safe` the way `agent.delegate` is: the
 * delegate stays inside the fleet, under every per-agent allowlist and the
 * same approval policy, while this speaks to people who did not ask. The
 * unattended path is the schedule carve-out — `destinationFor` names where
 * this call would speak, and the policy allows it exactly when the firing's
 * schedule was approved with that destination.
 */
export const createMessageSendTool = (send: OutboundMessenger): Tool => ({
  name: MESSAGE_SEND_TOOL_NAME,
  description: 'Send a message to a channel or DM you are not currently talking in. Scheduled turns may post to their schedule\'s approved destination without asking; anywhere else needs approval.',
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      destination: {
        ...DESTINATION_PARAMETER,
        description: 'Where to post: the channel kind plus the channel-native conversation id.',
      },
      text: { type: 'string', description: 'The message text.' },
    },
    required: ['destination', 'text'],
  },
  destinationFor(input: JsonObject) {
    const destination = parseDestinationInput(input.destination);
    return destination ? canonicalDestination(destination) : undefined;
  },
  async execute(input: JsonObject, session: Session) {
    const destination = parseDestinationInput(input.destination);
    if (!destination) {
      throw new Error('message.send requires "destination" as { channel, to } with non-empty strings.');
    }
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) {
      throw new Error('message.send requires a non-empty "text".');
    }
    await send({ agentId: session.agent.id, destination, text });
    return { sent: true, destination: canonicalDestination(destination) };
  },
});

export const MESSAGE_READ_TOOL_NAME = 'message.read';

/** The most messages one `message.read` call returns. */
export const MESSAGE_READ_MAX_LIMIT = 200;
const MESSAGE_READ_DEFAULT_LIMIT = 50;
/**
 * The most a call returns, in characters of the serialized messages: text,
 * names, file names, and ids together. A count alone does not bound a
 * read: fifty long posts can outgrow a model's context, and the result is
 * kept in the transcript and sent on every later turn. A read that reaches
 * it stops at the last whole message that fit and says `more`, so the
 * agent pages on with `before`/`after`.
 */
export const MESSAGE_READ_TEXT_BUDGET = 40_000;
const TRUNCATED_MARK = ' [... the rest of this message is not shown]';

/**
 * Reads one conversation, or one thread in it, through the agent's own
 * channel app. The gateway implements it over the channel contract's
 * `readConversation`, structurally mirrored here the way `OutboundMessenger`
 * mirrors `resolveOutbound`; rejecting is how a channel says it will not.
 */
export type ConversationReader = (input: {
  agentId: string;
  source: ScheduleDestination;
  thread?: string;
  after?: string;
  before?: string;
  limit: number;
}) => Promise<{
  messages: Array<{
    id: string;
    author: string;
    authorName?: string;
    text: string;
    at?: string;
    thread?: string;
    replies?: number;
    files?: string[];
  }>;
  more: boolean;
}>;

const optionalId = (input: JsonObject, key: string): string | undefined => {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`message.read: "${key}" must be a non-empty string when given.`);
  }
  return value.trim();
};

/**
 * Read a conversation's recent messages, or one thread — so an agent can
 * catch up on a channel it was not mentioned in.
 *
 * `gated`, like `message.send`: what a channel says is the people in it's,
 * and an agent talking somewhere else would carry it there. Judged by its
 * source (`destinationFor`) for the same reason as a send: a durable
 * per-tool grant would be a standing yes to every conversation the app is
 * in, which anyone who can talk to the agent could then have it quote
 * anywhere. So **Always allow** lasts for this session only, and a
 * schedule approved with a destination may read that one conversation
 * unattended. The channel's own rule decides which conversations are
 * readable at all. Output is `external`: the messages are written by
 * whoever is in the conversation, not by the operator.
 */
export const createMessageReadTool = (read: ConversationReader): Tool => ({
  name: MESSAGE_READ_TOOL_NAME,
  description: 'Read recent messages in a channel your app is a member of, or one thread in it. '
    + 'Without thread: the top level, newest first. With thread: that thread\'s root and replies, oldest first. '
    + 'For Slack, ids are channel ids and message ts values; a permalink '
    + '…/archives/C0123456789/p1791332967606559 is channel C0123456789 and message 1791332967.606559, '
    + 'and a thread_ts in the link is the thread to read. '
    + 'When more is true, page on with before (top level) or after (thread) set to the last id returned.',
  risk: 'gated',
  outputTrust: 'external',
  parameters: {
    type: 'object',
    properties: {
      source: {
        ...DESTINATION_PARAMETER,
        description: 'The conversation to read: the channel kind plus the channel-native conversation id.',
      },
      thread: { type: 'string', description: 'The root message id of a thread to read instead of the top level.' },
      after: { type: 'string', description: 'Only messages after this message id, exclusive.' },
      before: { type: 'string', description: 'Only messages before this message id, exclusive.' },
      limit: { type: 'integer', description: `How many messages, ${MESSAGE_READ_DEFAULT_LIMIT} by default, at most ${MESSAGE_READ_MAX_LIMIT}.` },
    },
    required: ['source'],
  },
  destinationFor(input: JsonObject) {
    const source = parseDestinationInput(input.source);
    return source ? canonicalDestination(source) : undefined;
  },
  async execute(input: JsonObject, session: Session) {
    const source = parseDestinationInput(input.source);
    if (!source) {
      throw new Error('message.read requires "source" as { channel, to } with non-empty strings.');
    }
    const thread = optionalId(input, 'thread');
    const after = optionalId(input, 'after');
    const before = optionalId(input, 'before');
    const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MESSAGE_READ_MAX_LIMIT)
      : MESSAGE_READ_DEFAULT_LIMIT;
    const result = await read({
      agentId: session.agent.id,
      source,
      limit,
      ...(thread !== undefined ? { thread } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(before !== undefined ? { before } : {}),
    });
    const messages: Array<Awaited<ReturnType<ConversationReader>>['messages'][number]> = [];
    let used = 0;
    let more = result.more;
    for (const message of result.messages) {
      const size = JSON.stringify(message).length;
      if (used + size <= MESSAGE_READ_TEXT_BUDGET) {
        messages.push({ ...message });
        used += size;
        continue;
      }
      // One message bigger than the whole budget is cut rather than
      // dropped, or the read could never get past it. Its file list goes
      // too, said by count, since a list can be as long as any text.
      if (messages.length === 0) {
        const { files, ...rest } = message;
        const cut = {
          ...rest,
          text: message.text.slice(0, MESSAGE_READ_TEXT_BUDGET / 2) + TRUNCATED_MARK,
          ...(files && files.length > 0 ? { files: [`${files.length} files, not listed`] } : {}),
        };
        messages.push(cut);
      }
      more = true;
      break;
    }
    return {
      source: canonicalDestination(source),
      ...(thread !== undefined ? { thread } : {}),
      count: messages.length,
      more,
      messages,
    } as JsonObject;
  },
});
